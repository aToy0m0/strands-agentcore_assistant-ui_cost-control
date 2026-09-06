import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { NanoUsd, RateCard } from "./cost.js";

export type PricingRouting = "geo-us" | "in-region" | "global";

export type PricingSnapshot = {
  modelId: string;
  catalogVersion: string;
  catalogS3VersionId: string;
  verifiedAt: string;
  reviewDueAt: string;
  inputPerMillionTokens: NanoUsd;
  outputPerMillionTokens: NanoUsd;
  contextTierMaxInputTokens?: number;
};

type PricingCatalogConfig = {
  bucketName: string;
  objectKey: string;
  sourceRegion: string;
  serviceTier: "standard";
  warningSink?: (warning: PricingWarning) => void;
};

export type PricingWarning = {
  event: "pricing.configuration.warning";
  modelId: string;
  reason: "CONDITION_MISMATCH" | "REVIEW_OVERDUE";
  details: Record<string, string>;
};

export class ModelPricingUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelPricingUnavailableError";
  }
}

export class S3ModelPricingCatalog {
  constructor(private readonly client: S3Client, private readonly config: PricingCatalogConfig) {}

  async requiredSnapshot(modelId: string, routing: PricingRouting, now = new Date(), sourceRegion = this.config.sourceRegion, inputTokens?: number): Promise<PricingSnapshot> {
    if (!modelId) throw new Error("modelId is required for pricing");
    if (Number.isNaN(now.getTime())) throw new Error("pricing validation date is invalid");
    let result;
    try {
      result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucketName, Key: this.config.objectKey }));
    } catch (cause) {
      throw new ModelPricingUnavailableError("承認済みモデル価格表を取得できないため実行を停止しました", { cause });
    }
    const versionId = result.VersionId;
    if (!versionId || !result.Body) throw new ModelPricingUnavailableError("承認済みモデル価格表のS3バージョンを確認できません");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await result.Body.transformToString("utf8"));
    } catch (cause) {
      throw new ModelPricingUnavailableError("承認済みモデル価格表が有効なJSONではありません", { cause });
    }
    return parseCatalog(parsed, modelId, routing, sourceRegion, this.config.serviceTier, versionId, now, this.config.warningSink, inputTokens);
  }
}

export function rateCard(snapshot: PricingSnapshot): RateCard {
  return { inputPerMillionTokens: snapshot.inputPerMillionTokens, outputPerMillionTokens: snapshot.outputPerMillionTokens };
}

function parseCatalog(
  value: unknown,
  modelId: string,
  expectedRouting: PricingRouting,
  expectedRegion: string,
  expectedTier: "standard",
  versionId: string,
  now: Date,
  warningSink?: (warning: PricingWarning) => void,
  inputTokens?: number,
): PricingSnapshot {
  const root = requiredObject(value, "price catalog");
  if (root.schemaVersion !== 1) throw new ModelPricingUnavailableError("承認済みモデル価格表のschemaVersionが不正です");
  const catalogVersion = requiredString(root.catalogVersion, "catalogVersion");
  if (root.currency !== "USD") throw new ModelPricingUnavailableError("承認済みモデル価格表の通貨はUSDである必要があります");
  const models = requiredObject(root.models, "models");
  const model = requiredObject(models[modelId], `models.${modelId}`);
  const verifiedAt = requiredDate(model.verifiedAt, "verifiedAt");
  const reviewDueAt = requiredDate(model.reviewDueAt, "reviewDueAt");
  const sourceRegion = requiredString(model.sourceRegion, "sourceRegion");
  const routing = requiredString(model.routing, "routing");
  const serviceTier = requiredString(model.serviceTier, "serviceTier");
  const mismatches: Record<string, string> = {};
  if (sourceRegion !== expectedRegion) mismatches.sourceRegion = `catalog=${sourceRegion}, runtime=${expectedRegion}`;
  if (routing !== expectedRouting) mismatches.routing = `catalog=${routing}, runtime=${expectedRouting}`;
  if (serviceTier !== expectedTier) mismatches.serviceTier = `catalog=${serviceTier}, runtime=${expectedTier}`;
  if (Object.keys(mismatches).length > 0) warningSink?.({ event: "pricing.configuration.warning", modelId, reason: "CONDITION_MISMATCH", details: mismatches });
  if (Date.parse(reviewDueAt) < now.getTime()) {
    warningSink?.({ event: "pricing.configuration.warning", modelId, reason: "REVIEW_OVERDUE", details: { reviewDueAt } });
  }
  const contextTier = resolveContextTier(model.contextPriceTiers, inputTokens);
  return {
    modelId,
    catalogVersion,
    catalogS3VersionId: versionId,
    verifiedAt,
    reviewDueAt,
    inputPerMillionTokens: requiredPositiveNanoUsd(contextTier?.inputNanoUsdPerMillionTokens ?? model.inputNanoUsdPerMillionTokens, "inputNanoUsdPerMillionTokens"),
    outputPerMillionTokens: requiredPositiveNanoUsd(contextTier?.outputNanoUsdPerMillionTokens ?? model.outputNanoUsdPerMillionTokens, "outputNanoUsdPerMillionTokens"),
    ...(contextTier ? { contextTierMaxInputTokens: Number(contextTier.maxInputTokens) } : {}),
  };
}

function resolveContextTier(value: unknown, inputTokens?: number): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new ModelPricingUnavailableError("承認済みモデル価格表のcontextPriceTiersが不正です");
  if (!Number.isSafeInteger(inputTokens) || inputTokens! < 0) throw new ModelPricingUnavailableError("コンテキスト段階価格には入力トークン数が必要です");
  let previousMaximum = 0;
  for (const [index, entry] of value.entries()) {
    const tier = requiredObject(entry, `contextPriceTiers[${index}]`);
    const maximum = tier.maxInputTokens;
    if (!Number.isSafeInteger(maximum) || Number(maximum) <= previousMaximum) throw new ModelPricingUnavailableError("承認済みモデル価格表のcontextPriceTiers.maxInputTokensが不正です");
    previousMaximum = Number(maximum);
    if (inputTokens! <= previousMaximum) return tier;
  }
  throw new ModelPricingUnavailableError("入力トークン数に対応する承認済みコンテキスト価格がありません");
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ModelPricingUnavailableError(`承認済みモデル価格表の${name}が不正です`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ModelPricingUnavailableError(`承認済みモデル価格表の${name}が不正です`);
  return value;
}

function requiredDate(value: unknown, name: string): string {
  const date = requiredString(value, name);
  if (Number.isNaN(Date.parse(date))) throw new ModelPricingUnavailableError(`承認済みモデル価格表の${name}が日時ではありません`);
  return date;
}

function requiredPositiveNanoUsd(value: unknown, name: string): NanoUsd {
  if (typeof value !== "string" || !/^\d+$/u.test(value) || BigInt(value) <= 0n) {
    throw new ModelPricingUnavailableError(`承認済みモデル価格表の${name}が不正です`);
  }
  return BigInt(value);
}
