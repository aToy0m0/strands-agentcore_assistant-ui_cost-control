import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { NanoUsd } from "./cost.js";
import type { PricingSnapshot } from "./pricing-catalog.js";

export type Reservation = {
  requestId: string;
  month: string;
  accountId: string;
  projectId: string;
  modelId: string;
  pricingVersion: string;
  pricingHistoryKey: string;
  pricingVerifiedAt: string;
  pricingVerifiedUntil: string;
  inputNanoUsdPerMillionTokens: NanoUsd;
  outputNanoUsdPerMillionTokens: NanoUsd;
  reservedNanoUsd: NanoUsd;
  actorId: string;
  userProfileId: string;
  userWindow: string;
  reservedTokens: number;
  settlementMode: SettlementMode;
  status: "RESERVED" | "SETTLED";
  actualNanoUsd?: NanoUsd;
  actualTokens?: number;
};

export type SettlementMode = "bounded" | "usage-only";

export class BudgetExceededError extends Error {
  constructor() {
    super("LLMの費用上限またはユーザートークン上限に達したため、呼び出しを開始しませんでした");
    this.name = "BudgetExceededError";
  }
}

type LedgerConfig = {
  tableName: string;
  accountId: string;
  projectId: string;
  accountLimitNanoUsd: NanoUsd;
  projectLimitNanoUsd: NanoUsd;
};

export type UserTokenLimit = {
  actorId: string;
  profileId: string;
  window: string;
  tokenLimit: number;
  maximumTokens: number;
};

export class DynamoBudgetLedger {
  constructor(private readonly client: DynamoDBClient, private readonly config: LedgerConfig) {}

  async reserve(input: { requestId: string; month: string; modelId: string; maximumNanoUsd: NanoUsd; settlementMode: SettlementMode; pricing: PricingSnapshot; user: UserTokenLimit }): Promise<Reservation> {
    if (input.maximumNanoUsd < 0n) throw new Error("maximumNanoUsd must not be negative");
    if (input.pricing.modelId !== input.modelId) throw new Error("pricing modelId must match reservation modelId");
    validateUserTokenLimit(input.user);
    const reservation: Reservation = {
      requestId: input.requestId,
      month: input.month,
      modelId: input.modelId,
      pricingVersion: input.pricing.version,
      pricingHistoryKey: `${input.pricing.verifiedAt}#${input.pricing.version}`,
      pricingVerifiedAt: input.pricing.verifiedAt,
      pricingVerifiedUntil: input.pricing.verifiedUntil,
      inputNanoUsdPerMillionTokens: input.pricing.inputPerMillionTokens,
      outputNanoUsdPerMillionTokens: input.pricing.outputPerMillionTokens,
      accountId: this.config.accountId,
      projectId: this.config.projectId,
      reservedNanoUsd: input.maximumNanoUsd,
      actorId: input.user.actorId,
      userProfileId: input.user.profileId,
      userWindow: input.user.window,
      reservedTokens: input.user.maximumTokens,
      settlementMode: input.settlementMode,
      status: "RESERVED",
    };
    const transaction: TransactWriteItemsCommandInput = {
      TransactItems: [
        this.reserveCounter(input.month, `ACCOUNT#${this.config.accountId}`, this.config.accountLimitNanoUsd, input.maximumNanoUsd),
        this.reserveCounter(input.month, `PROJECT#${this.config.projectId}`, this.config.projectLimitNanoUsd, input.maximumNanoUsd),
        this.reserveTokenCounter(input.user),
        { Put: { TableName: this.config.tableName, Item: serializeReservation(reservation), ConditionExpression: "attribute_not_exists(PK)" } },
      ],
    };
    try {
      await this.client.send(new TransactWriteItemsCommand(transaction));
      return reservation;
    } catch (cause) {
      const existing = await this.get(input.requestId);
      if (existing && sameReservation(existing, reservation)) return existing;
      if (cause instanceof Error && cause.name === "TransactionCanceledException") throw new BudgetExceededError();
      throw cause;
    }
  }

  async settle(requestId: string, actualNanoUsd: NanoUsd, actualTokens: number): Promise<Reservation> {
    const reservation = await this.required(requestId);
    if (reservation.status === "SETTLED") {
      if (reservation.actualNanoUsd === actualNanoUsd && reservation.actualTokens === actualTokens) return reservation;
      throw new Error(`reservation was already settled with another amount: ${requestId}`);
    }
    if (actualNanoUsd < 0n || (reservation.settlementMode === "bounded" && actualNanoUsd > reservation.reservedNanoUsd)) {
      throw new Error(`actual cost is outside the reserved amount: ${requestId}`);
    }
    if (!Number.isSafeInteger(actualTokens) || actualTokens < 0 || (reservation.settlementMode === "bounded" && actualTokens > reservation.reservedTokens)) {
      throw new Error(`actual tokens are outside the reserved amount: ${requestId}`);
    }
    const difference = actualNanoUsd - reservation.reservedNanoUsd;
    const tokenDifference = actualTokens - reservation.reservedTokens;
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: [
      this.settleCounter(reservation.month, `ACCOUNT#${reservation.accountId}`, reservation.reservedNanoUsd, actualNanoUsd, difference),
      this.settleCounter(reservation.month, `PROJECT#${reservation.projectId}`, reservation.reservedNanoUsd, actualNanoUsd, difference),
      this.settleTokenCounter(reservation, actualTokens, tokenDifference),
      { Update: {
        TableName: this.config.tableName,
        Key: requestKey(requestId),
        UpdateExpression: "SET #status = :settled, actualNanoUsd = :actual, actualTokens = :actualTokens",
        ConditionExpression: "#status = :reserved AND reservedNanoUsd = :maximum AND reservedTokens = :maximumTokens",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":settled": { S: "SETTLED" },
          ":reserved": { S: "RESERVED" },
          ":actual": numberValue(actualNanoUsd),
          ":maximum": numberValue(reservation.reservedNanoUsd),
          ":actualTokens": numberValue(BigInt(actualTokens)),
          ":maximumTokens": numberValue(BigInt(reservation.reservedTokens)),
        },
      } },
    ] }));
    return { ...reservation, status: "SETTLED", actualNanoUsd, actualTokens };
  }

  private reserveCounter(month: string, scope: string, limit: NanoUsd, cost: NanoUsd) {
    const remaining = limit - cost;
    return { Update: {
      TableName: this.config.tableName,
      Key: key(`MONTH#${month}`, scope),
      UpdateExpression: "SET #limit = if_not_exists(#limit, :limit), committedNanoUsd = if_not_exists(committedNanoUsd, :zero) + :cost, reservedNanoUsd = if_not_exists(reservedNanoUsd, :zero) + :cost, spentNanoUsd = if_not_exists(spentNanoUsd, :zero)",
      ConditionExpression: ":remaining >= :zero AND (attribute_not_exists(#limit) OR #limit = :limit) AND (attribute_not_exists(committedNanoUsd) OR committedNanoUsd <= :remaining)",
      ExpressionAttributeNames: { "#limit": "limitNanoUsd" },
      ExpressionAttributeValues: { ":limit": numberValue(limit), ":zero": numberValue(0n), ":cost": numberValue(cost), ":remaining": numberValue(remaining) },
    } };
  }

  private settleCounter(month: string, scope: string, reserved: NanoUsd, actual: NanoUsd, difference: NanoUsd) {
    return { Update: {
      TableName: this.config.tableName,
      Key: key(`MONTH#${month}`, scope),
      UpdateExpression: "SET committedNanoUsd = committedNanoUsd + :difference, reservedNanoUsd = reservedNanoUsd - :reserved, spentNanoUsd = spentNanoUsd + :actual",
      ConditionExpression: "reservedNanoUsd >= :reserved AND committedNanoUsd >= :reserved",
      ExpressionAttributeValues: { ":difference": numberValue(difference), ":reserved": numberValue(reserved), ":actual": numberValue(actual) },
    } };
  }

  private reserveTokenCounter(user: UserTokenLimit) {
    const remaining = BigInt(user.tokenLimit - user.maximumTokens);
    return { Update: {
      TableName: this.config.tableName,
      Key: key(`USER_WINDOW#${user.window}`, `USER#${user.actorId}`),
      UpdateExpression: "SET profileId = if_not_exists(profileId, :profile), #limit = if_not_exists(#limit, :limit), committedTokens = if_not_exists(committedTokens, :zero) + :tokens, reservedTokens = if_not_exists(reservedTokens, :zero) + :tokens, spentTokens = if_not_exists(spentTokens, :zero)",
      ConditionExpression: ":remaining >= :zero AND (attribute_not_exists(profileId) OR profileId = :profile) AND (attribute_not_exists(#limit) OR #limit = :limit) AND (attribute_not_exists(committedTokens) OR committedTokens <= :remaining)",
      ExpressionAttributeNames: { "#limit": "limitTokens" },
      ExpressionAttributeValues: {
        ":profile": { S: user.profileId }, ":limit": numberValue(BigInt(user.tokenLimit)), ":zero": numberValue(0n),
        ":tokens": numberValue(BigInt(user.maximumTokens)), ":remaining": numberValue(remaining),
      },
    } };
  }

  private settleTokenCounter(reservation: Reservation, actualTokens: number, tokenDifference: number) {
    return { Update: {
      TableName: this.config.tableName,
      Key: key(`USER_WINDOW#${reservation.userWindow}`, `USER#${reservation.actorId}`),
      UpdateExpression: "SET committedTokens = committedTokens + :difference, reservedTokens = reservedTokens - :reserved, spentTokens = spentTokens + :actual",
      ConditionExpression: "profileId = :profile AND reservedTokens >= :reserved AND committedTokens >= :reserved",
      ExpressionAttributeValues: {
        ":profile": { S: reservation.userProfileId }, ":difference": numberValue(BigInt(tokenDifference)),
        ":reserved": numberValue(BigInt(reservation.reservedTokens)), ":actual": numberValue(BigInt(actualTokens)),
      },
    } };
  }

  private async required(requestId: string): Promise<Reservation> {
    const reservation = await this.get(requestId);
    if (!reservation) throw new Error(`reservation not found: ${requestId}`);
    return reservation;
  }

  private async get(requestId: string): Promise<Reservation | undefined> {
    const result = await this.client.send(new GetItemCommand({ TableName: this.config.tableName, Key: requestKey(requestId), ConsistentRead: true }));
    return result.Item ? deserializeReservation(result.Item) : undefined;
  }
}

function key(pk: string, sk: string): Record<string, AttributeValue> { return { PK: { S: pk }, SK: { S: sk } }; }
function requestKey(requestId: string) { return key(`REQUEST#${requestId}`, "RESERVATION"); }
function numberValue(value: bigint): AttributeValue { return { N: value.toString() }; }

function serializeReservation(value: Reservation) {
  return {
    ...requestKey(value.requestId),
    requestId: { S: value.requestId }, month: { S: value.month }, accountId: { S: value.accountId }, projectId: { S: value.projectId },
    modelId: { S: value.modelId }, reservedNanoUsd: numberValue(value.reservedNanoUsd),
    pricingVersion: { S: value.pricingVersion }, pricingHistoryKey: { S: value.pricingHistoryKey }, pricingVerifiedAt: { S: value.pricingVerifiedAt }, pricingVerifiedUntil: { S: value.pricingVerifiedUntil },
    inputNanoUsdPerMillionTokens: numberValue(value.inputNanoUsdPerMillionTokens), outputNanoUsdPerMillionTokens: numberValue(value.outputNanoUsdPerMillionTokens),
    actorId: { S: value.actorId }, userProfileId: { S: value.userProfileId }, userWindow: { S: value.userWindow },
    reservedTokens: numberValue(BigInt(value.reservedTokens)), settlementMode: { S: value.settlementMode }, status: { S: value.status },
  };
}

function deserializeReservation(item: Record<string, AttributeValue>): Reservation {
  const requestId = item.requestId?.S; const month = item.month?.S; const accountId = item.accountId?.S;
  const projectId = item.projectId?.S; const modelId = item.modelId?.S; const reserved = item.reservedNanoUsd?.N;
  const pricingVersion = item.pricingVersion?.S; const pricingHistoryKey = item.pricingHistoryKey?.S; const pricingVerifiedAt = item.pricingVerifiedAt?.S; const pricingVerifiedUntil = item.pricingVerifiedUntil?.S;
  const inputRate = item.inputNanoUsdPerMillionTokens?.N; const outputRate = item.outputNanoUsdPerMillionTokens?.N;
  const actorId = item.actorId?.S; const userProfileId = item.userProfileId?.S; const userWindow = item.userWindow?.S; const reservedTokens = item.reservedTokens?.N;
  const settlementMode = item.settlementMode?.S; const status = item.status?.S; const actual = item.actualNanoUsd?.N; const actualTokens = item.actualTokens?.N;
  if (!requestId || !month || !accountId || !projectId || !modelId || !reserved || !pricingVersion || !pricingHistoryKey || !pricingVerifiedAt || !pricingVerifiedUntil || !inputRate || !outputRate || !actorId || !userProfileId || !userWindow || !reservedTokens || (settlementMode !== "bounded" && settlementMode !== "usage-only") || (status !== "RESERVED" && status !== "SETTLED")) {
    throw new Error("invalid budget reservation item");
  }
  const reservedTokenCount = safeTokenNumber(reservedTokens);
  const actualTokenCount = actualTokens === undefined ? undefined : safeTokenNumber(actualTokens);
  return {
    requestId, month, accountId, projectId, modelId, reservedNanoUsd: BigInt(reserved),
    pricingVersion, pricingHistoryKey, pricingVerifiedAt, pricingVerifiedUntil, inputNanoUsdPerMillionTokens: BigInt(inputRate), outputNanoUsdPerMillionTokens: BigInt(outputRate),
    actorId, userProfileId, userWindow,
    reservedTokens: reservedTokenCount, settlementMode, status,
    ...(actual === undefined ? {} : { actualNanoUsd: BigInt(actual) }),
    ...(actualTokenCount === undefined ? {} : { actualTokens: actualTokenCount }),
  };
}

function sameReservation(left: Reservation, right: Reservation): boolean {
  return left.requestId === right.requestId && left.month === right.month && left.accountId === right.accountId && left.projectId === right.projectId
    && left.modelId === right.modelId && left.reservedNanoUsd === right.reservedNanoUsd && left.actorId === right.actorId
    && left.pricingVersion === right.pricingVersion && left.pricingHistoryKey === right.pricingHistoryKey && left.pricingVerifiedAt === right.pricingVerifiedAt && left.pricingVerifiedUntil === right.pricingVerifiedUntil
    && left.inputNanoUsdPerMillionTokens === right.inputNanoUsdPerMillionTokens && left.outputNanoUsdPerMillionTokens === right.outputNanoUsdPerMillionTokens
    && left.userProfileId === right.userProfileId && left.userWindow === right.userWindow && left.reservedTokens === right.reservedTokens
    && left.settlementMode === right.settlementMode;
}

function validateUserTokenLimit(user: UserTokenLimit): void {
  if (!user.actorId || !user.profileId || !user.window) throw new Error("user token limit identity is required");
  if (!Number.isSafeInteger(user.tokenLimit) || user.tokenLimit <= 0) throw new Error("user token limit must be a positive safe integer");
  if (!Number.isSafeInteger(user.maximumTokens) || user.maximumTokens < 0) throw new Error("maximum user tokens must be a non-negative safe integer");
}

function safeTokenNumber(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("invalid token count in budget reservation");
  const tokens = Number(value);
  if (!Number.isSafeInteger(tokens)) throw new Error("token count in budget reservation exceeds the safe integer range");
  return tokens;
}
