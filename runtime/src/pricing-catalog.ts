import { DynamoDBClient, GetItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import type { NanoUsd, RateCard } from "./cost.js";

export type PricingRouting = "geo-us" | "in-region";

export type PricingSnapshot = {
  modelId: string;
  version: string;
  verifiedAt: string;
  verifiedUntil: string;
  inputPerMillionTokens: NanoUsd;
  outputPerMillionTokens: NanoUsd;
};

type PricingCatalogConfig = {
  tableName: string;
  sourceRegion: string;
  serviceTier: "standard";
};

export class ModelPricingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPricingUnavailableError";
  }
}

export class DynamoModelPricingCatalog {
  constructor(private readonly client: DynamoDBClient, private readonly config: PricingCatalogConfig) {}

  async requiredSnapshot(modelId: string, routing: PricingRouting, now = new Date()): Promise<PricingSnapshot> {
    if (!modelId) throw new Error("modelId is required for pricing");
    if (Number.isNaN(now.getTime())) throw new Error("pricing validation date is invalid");
    const result = await this.client.send(new GetItemCommand({
      TableName: this.config.tableName,
      Key: { modelId: { S: modelId } },
      ConsistentRead: true,
    }));
    if (!result.Item) throw new ModelPricingUnavailableError(`モデル価格が登録されていないため実行を停止しました: ${modelId}`);
    return parseSnapshot(result.Item, { modelId, routing, ...this.config }, now);
  }
}

export function rateCard(snapshot: PricingSnapshot): RateCard {
  return {
    inputPerMillionTokens: snapshot.inputPerMillionTokens,
    outputPerMillionTokens: snapshot.outputPerMillionTokens,
  };
}

function parseSnapshot(
  item: Record<string, AttributeValue>,
  expected: PricingCatalogConfig & { modelId: string; routing: PricingRouting },
  now: Date,
): PricingSnapshot {
  const modelId = requiredString(item, "modelId");
  const status = requiredString(item, "status");
  const currency = requiredString(item, "currency");
  const sourceRegion = requiredString(item, "sourceRegion");
  const routing = requiredString(item, "routing");
  const serviceTier = requiredString(item, "serviceTier");
  const version = requiredString(item, "version");
  const verifiedAt = requiredDate(item, "verifiedAt");
  const verifiedUntil = requiredDate(item, "verifiedUntil");
  const inputPerMillionTokens = requiredPositiveNanoUsd(item, "inputNanoUsdPerMillionTokens");
  const outputPerMillionTokens = requiredPositiveNanoUsd(item, "outputNanoUsdPerMillionTokens");

  if (modelId !== expected.modelId || sourceRegion !== expected.sourceRegion || routing !== expected.routing || serviceTier !== expected.serviceTier || currency !== "USD") {
    throw new ModelPricingUnavailableError(`モデル価格の適用条件が一致しないため実行を停止しました: ${expected.modelId}`);
  }
  if (status !== "ACTIVE") throw new ModelPricingUnavailableError(`モデル価格が有効ではないため実行を停止しました: ${expected.modelId}`);
  if (now.getTime() < Date.parse(verifiedAt) || now.getTime() > Date.parse(verifiedUntil)) {
    throw new ModelPricingUnavailableError(`モデル価格の確認期限外のため実行を停止しました: ${expected.modelId}`);
  }
  return { modelId, version, verifiedAt, verifiedUntil, inputPerMillionTokens, outputPerMillionTokens };
}

function requiredString(item: Record<string, AttributeValue>, name: string): string {
  const value = item[name]?.S;
  if (!value?.trim()) throw new ModelPricingUnavailableError(`モデル価格の${name}が不正です`);
  return value;
}

function requiredDate(item: Record<string, AttributeValue>, name: string): string {
  const value = requiredString(item, name);
  if (Number.isNaN(Date.parse(value))) throw new ModelPricingUnavailableError(`モデル価格の${name}が日時ではありません`);
  return value;
}

function requiredPositiveNanoUsd(item: Record<string, AttributeValue>, name: string): NanoUsd {
  const value = item[name]?.N;
  if (!value || !/^\d+$/u.test(value)) throw new ModelPricingUnavailableError(`モデル価格の${name}が不正です`);
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new ModelPricingUnavailableError(`モデル価格の${name}は0より大きい必要があります`);
  return parsed;
}
