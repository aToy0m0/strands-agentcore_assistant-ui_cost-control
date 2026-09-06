import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { NanoUsd } from "./cost.js";

const IDEMPOTENCY_RETENTION_SECONDS = 180 * 24 * 60 * 60;

export type UsageStatus = "APPLIED" | "NO_CHARGE" | "USAGE_UNAVAILABLE" | "UNCERTAIN" | "RESOLVED_NO_COST";

export type UsageRecord = {
  usageEventId: string;
  month: string;
  modelId: string;
  status: UsageStatus;
  inputTokens?: number;
  outputTokens?: number;
  costNanoUsd?: NanoUsd;
  createdAt: string;
  resolvedAt?: string;
};

export class BudgetExceededError extends Error {
  constructor() {
    super("LLMの月額上限に達したため、呼び出しを開始しませんでした");
    this.name = "BudgetExceededError";
  }
}

type LedgerConfig = {
  tableName: string;
  budgetScopeId: string;
};

type AppliedUsage = {
  usageEventId: string;
  month: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costNanoUsd: NanoUsd;
  occurredAt: Date;
};

type UnpricedUsage = {
  usageEventId: string;
  month: string;
  modelId: string;
  status: "NO_CHARGE" | "USAGE_UNAVAILABLE";
  occurredAt: Date;
};

export class DynamoBudgetLedger {
  constructor(private readonly client: DynamoDBClient, private readonly config: LedgerConfig) {}

  async assertCanStart(month: string, estimatedInputNanoUsd: NanoUsd): Promise<void> {
    if (estimatedInputNanoUsd < 0n) throw new Error("estimatedInputNanoUsd must not be negative");
    const [configuration, monthResult] = await Promise.all([
      this.client.send(new GetItemCommand({ TableName: this.config.tableName, Key: this.key("CONFIG"), ConsistentRead: true })),
      this.client.send(new GetItemCommand({ TableName: this.config.tableName, Key: this.key(`MONTH#${month}`), ConsistentRead: true })),
    ]);
    const limitValue = configuration.Item?.limitNanoUsd?.N;
    if (!limitValue || !/^\d+$/u.test(limitValue) || BigInt(limitValue) <= 0n) {
      throw new Error("monthly budget configuration is unavailable or invalid");
    }
    const spentNanoUsd = optionalNonNegativeBigInt(monthResult.Item?.spentNanoUsd, "spentNanoUsd");
    if (spentNanoUsd + estimatedInputNanoUsd > BigInt(limitValue)) throw new BudgetExceededError();
  }

  async recordUsage(input: AppliedUsage): Promise<UsageRecord> {
    validateAppliedUsage(input);
    const record: UsageRecord = {
      usageEventId: input.usageEventId, month: input.month, modelId: input.modelId, status: "APPLIED",
      inputTokens: input.inputTokens, outputTokens: input.outputTokens, costNanoUsd: input.costNanoUsd,
      createdAt: input.occurredAt.toISOString(),
    };
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: [
        { Put: {
          TableName: this.config.tableName,
          Item: this.serializeUsage(record, input.occurredAt),
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        } },
        { Update: {
          TableName: this.config.tableName,
          Key: this.key(`MONTH#${input.month}`),
          UpdateExpression: "SET spentNanoUsd = if_not_exists(spentNanoUsd, :zero) + :cost, updatedAt = :updatedAt",
          ExpressionAttributeValues: { ":zero": numberValue(0n), ":cost": numberValue(input.costNanoUsd), ":updatedAt": { S: input.occurredAt.toISOString() } },
        } },
      ] }));
      return record;
    } catch (cause) {
      return this.existingOrThrow(record, cause);
    }
  }

  async recordUnpricedUsage(input: UnpricedUsage): Promise<UsageRecord> {
    validateIdentity(input);
    const record: UsageRecord = {
      usageEventId: input.usageEventId, month: input.month, modelId: input.modelId,
      status: input.status, createdAt: input.occurredAt.toISOString(),
    };
    try {
      await this.client.send(new PutItemCommand({
        TableName: this.config.tableName,
        Item: this.serializeUsage(record, input.occurredAt),
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      }));
      return record;
    } catch (cause) {
      return this.existingOrThrow(record, cause);
    }
  }

  private key(sk: string): Record<string, AttributeValue> {
    return { PK: { S: `APP#${this.config.budgetScopeId}` }, SK: { S: sk } };
  }

  private serializeUsage(record: UsageRecord, occurredAt: Date): Record<string, AttributeValue> {
    return {
      ...this.key(`USAGE#${record.usageEventId}`),
      usageEventId: { S: record.usageEventId }, month: { S: record.month }, modelId: { S: record.modelId },
      status: { S: record.status }, createdAt: { S: record.createdAt },
      expiresAt: numberValue(BigInt(Math.floor(occurredAt.getTime() / 1000) + IDEMPOTENCY_RETENTION_SECONDS)),
      ...(record.inputTokens === undefined ? {} : { inputTokens: numberValue(BigInt(record.inputTokens)) }),
      ...(record.outputTokens === undefined ? {} : { outputTokens: numberValue(BigInt(record.outputTokens)) }),
      ...(record.costNanoUsd === undefined ? {} : { costNanoUsd: numberValue(record.costNanoUsd) }),
    };
  }

  private async existingOrThrow(expected: UsageRecord, cause: unknown): Promise<UsageRecord> {
    const existing = await this.getUsage(expected.usageEventId);
    if (existing && sameUsage(existing, expected)) return existing;
    if (existing) throw new Error(`usage event was already recorded with different content: ${expected.usageEventId}`, { cause });
    throw cause;
  }

  private async getUsage(usageEventId: string): Promise<UsageRecord | undefined> {
    const result = await this.client.send(new GetItemCommand({ TableName: this.config.tableName, Key: this.key(`USAGE#${usageEventId}`), ConsistentRead: true }));
    return result.Item ? deserializeUsage(result.Item) : undefined;
  }
}

function deserializeUsage(item: Record<string, AttributeValue>): UsageRecord {
  const usageEventId = item.usageEventId?.S;
  const month = item.month?.S;
  const modelId = item.modelId?.S;
  const status = item.status?.S;
  const createdAt = item.createdAt?.S;
  if (!usageEventId || !month || !modelId || !createdAt
    || (status !== "APPLIED" && status !== "NO_CHARGE" && status !== "USAGE_UNAVAILABLE"
      && status !== "UNCERTAIN" && status !== "RESOLVED_NO_COST")) {
    throw new Error("invalid usage event item");
  }
  return {
    usageEventId, month, modelId, status, createdAt,
    ...(item.inputTokens?.N === undefined ? {} : { inputTokens: safeTokenNumber(item.inputTokens.N, "inputTokens") }),
    ...(item.outputTokens?.N === undefined ? {} : { outputTokens: safeTokenNumber(item.outputTokens.N, "outputTokens") }),
    ...(item.costNanoUsd?.N === undefined ? {} : { costNanoUsd: BigInt(item.costNanoUsd.N) }),
    ...(item.resolvedAt?.S === undefined ? {} : { resolvedAt: item.resolvedAt.S }),
  };
}

function sameUsage(left: UsageRecord, right: UsageRecord): boolean {
  return left.usageEventId === right.usageEventId && left.month === right.month && left.modelId === right.modelId
    && left.status === right.status && left.inputTokens === right.inputTokens && left.outputTokens === right.outputTokens
    && left.costNanoUsd === right.costNanoUsd;
}

function validateIdentity(input: { usageEventId: string; month: string; modelId: string; occurredAt: Date }): void {
  if (!input.usageEventId || !input.modelId || !/^\d{4}-\d{2}$/u.test(input.month)) throw new Error("usage identity is invalid");
  if (Number.isNaN(input.occurredAt.getTime())) throw new Error("usage occurredAt is invalid");
}

function validateAppliedUsage(input: AppliedUsage): void {
  validateIdentity(input);
  validateTokenCount(input.inputTokens, "inputTokens");
  validateTokenCount(input.outputTokens, "outputTokens");
  if (input.costNanoUsd < 0n) throw new Error("costNanoUsd must not be negative");
}

function validateTokenCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

function optionalNonNegativeBigInt(value: AttributeValue | undefined, name: string): bigint {
  const encoded = value?.N ?? "0";
  if (!/^\d+$/u.test(encoded)) throw new Error(`${name} is invalid`);
  return BigInt(encoded);
}

function safeTokenNumber(value: string, name: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} is invalid`);
  const tokens = Number(value);
  if (!Number.isSafeInteger(tokens)) throw new Error(`${name} exceeds the safe integer range`);
  return tokens;
}

function numberValue(value: bigint): AttributeValue {
  return { N: value.toString() };
}
