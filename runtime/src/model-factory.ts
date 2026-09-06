import { randomUUID } from "node:crypto";
import { BedrockModel, type BedrockModelOptions, type Message, type ModelStreamEvent, type StreamOptions } from "@strands-agents/sdk";
import { GoogleModel, type GoogleModelOptions } from "@strands-agents/sdk/models/google";
import type { DynamoBudgetLedger, UsageStatus } from "./budget-ledger.js";
import { actualCost, totalTokens, utcMonth, type RateCard, type TokenUsage } from "./cost.js";
import { modelByKey, type InferenceSelection, type ReasoningEffort } from "../../shared/model-catalog.js";
import { rateCard, type PricingRouting, type PricingSnapshot, type S3ModelPricingCatalog } from "./pricing-catalog.js";
import { countTokensWithSource, type TokenCountSource } from "./token-count-logging.js";

const CLAUDE_BUDGET: Record<ReasoningEffort, number> = { low: 1_024, medium: 4_096, high: 8_192 };

type BudgetContext = {
  ledger: DynamoBudgetLedger;
  pricingCatalog: S3ModelPricingCatalog;
  pricingRouting: PricingRouting;
  pricingSourceRegion: string;
};

type ActiveUsage = {
  usageEventId: string;
  month: string;
  modelId: string;
  rate: RateCard;
  pricing: PricingSnapshot;
  tokenCountSource: TokenCountSource;
  estimatedInputTokens: number;
};

function requiredEffort(selection: InferenceSelection): ReasoningEffort {
  if (!selection.reasoning.enabled || !selection.reasoning.effort) throw new Error(`${selection.model} requires reasoning effort`);
  return selection.reasoning.effort;
}

export function bedrockModelOptions(region: string, selection: InferenceSelection, modelId: string): BedrockModelOptions {
  const model = modelByKey(selection.model);
  const common: BedrockModelOptions = {
    region, modelId, stream: true, maxTokens: model.maxOutputTokens, useNativeTokenCount: true,
  };
  switch (model.requestAdapter) {
    case "nova-reasoning": return { ...common, additionalRequestFields: selection.reasoning.enabled
      ? { reasoningConfig: { type: "enabled", maxReasoningEffort: requiredEffort(selection) } }
      : { reasoningConfig: { type: "disabled" } } };
    case "claude-budget": return selection.reasoning.enabled
      ? { ...common, additionalRequestFields: { thinking: { type: "enabled", budget_tokens: CLAUDE_BUDGET[requiredEffort(selection)] } } }
      : common;
    case "claude-adaptive": return selection.reasoning.enabled
      ? { ...common, additionalRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: requiredEffort(selection) } } }
      : common;
    case "claude-always-on": return { ...common, additionalRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: selection.reasoning.enabled ? requiredEffort(selection) : "low" } } };
    case "openai-reasoning": return { ...common, additionalRequestFields: { reasoning_effort: selection.reasoning.enabled ? requiredEffort(selection) : "low" } };
    case "glm-thinking": return { ...common, additionalRequestFields: { thinking: { type: selection.reasoning.enabled ? "enabled" : "disabled" } } };
    case "gemini-thinking": throw new Error(`${selection.model} is not a Bedrock model`);
  }
}

export function googleModelOptions(selection: InferenceSelection, apiKey: string, modelId: string): GoogleModelOptions {
  const model = modelByKey(selection.model);
  if (model.provider !== "google" || model.requestAdapter !== "gemini-thinking") throw new Error(`${selection.model} is not a Google model`);
  return {
    apiKey,
    modelId,
    maxTokens: model.maxOutputTokens,
    useNativeTokenCount: true,
    params: {
      maxOutputTokens: model.maxOutputTokens,
      thinkingConfig: selection.reasoning.enabled
        ? { thinkingLevel: requiredEffort(selection).toUpperCase() }
        : { thinkingLevel: "MINIMAL" },
    },
  };
}

export function createConfiguredModel(
  region: string,
  selection: InferenceSelection,
  ledger: DynamoBudgetLedger,
  pricingCatalog: S3ModelPricingCatalog,
  configuredModelId: string,
  googleApiKey?: string,
) {
  const model = modelByKey(selection.model);
  if (!configuredModelId) throw new Error(`Configured model ID is missing: ${selection.model}`);
  const context: BudgetContext = {
    ledger,
    pricingCatalog,
    pricingRouting: pricingRoutingFor(configuredModelId, model.provider),
    pricingSourceRegion: model.provider === "google" ? "global" : region,
  };
  if (model.provider === "google") {
    if (!googleApiKey) throw new Error("Gemini API key is not configured");
    return new BudgetControlledGoogleModel(googleModelOptions(selection, googleApiKey, configuredModelId), context);
  }
  return new BudgetControlledBedrockModel(bedrockModelOptions(region, selection, configuredModelId), context);
}

export function pricingRoutingFor(modelId: string, provider: string): PricingRouting {
  if (provider === "google" || modelId.startsWith("global.")) return "global";
  if (modelId.startsWith("us.")) return "geo-us";
  if (modelId.startsWith("jp.")) return "geo-jp";
  return "in-region";
}

async function prepare(
  modelId: string,
  provider: "bedrock" | "google",
  countTokens: () => Promise<number>,
  context: BudgetContext,
): Promise<ActiveUsage> {
  const count = await countTokensWithSource(modelId, provider, countTokens);
  const pricing = await context.pricingCatalog.requiredSnapshot(modelId, context.pricingRouting, new Date(), context.pricingSourceRegion, count.inputTokens);
  const rate = rateCard(pricing);
  const estimatedInputCost = actualCost({ inputTokens: count.inputTokens, outputTokens: 0 }, rate);
  const month = utcMonth();
  await context.ledger.assertCanStart(month, estimatedInputCost);
  console.log(JSON.stringify({ event: "model.token_count.recorded", modelId, inputTokens: count.inputTokens, source: count.source }));
  return {
    usageEventId: randomUUID(), month, modelId, rate, pricing,
    tokenCountSource: count.source, estimatedInputTokens: count.inputTokens,
  };
}

export function usageStatusWithoutUsage(failed: boolean, streamStarted: boolean): Extract<UsageStatus, "NO_CHARGE" | "USAGE_UNAVAILABLE"> {
  return failed && !streamStarted ? "NO_CHARGE" : "USAGE_UNAVAILABLE";
}

function failureDetails(failure: unknown): { failureName?: string; failureMessage?: string } {
  if (!(failure instanceof Error)) return {};
  return { failureName: failure.name, failureMessage: failure.message };
}

async function record(
  active: ActiveUsage,
  usage: TokenUsage | undefined,
  context: BudgetContext,
  failed: boolean,
  streamStarted: boolean,
  failure?: unknown,
): Promise<void> {
  const occurredAt = new Date();
  if (!usage) {
    const status = usageStatusWithoutUsage(failed, streamStarted);
    await context.ledger.recordUnpricedUsage({
      usageEventId: active.usageEventId, month: active.month, modelId: active.modelId, status, occurredAt,
    });
    console.error(JSON.stringify({
      event: status === "NO_CHARGE" ? "model.call.not_charged" : "model.usage.unavailable",
      usageEventId: active.usageEventId, modelId: active.modelId, month: active.month, status,
      tokenCountSource: active.tokenCountSource, estimatedInputTokens: active.estimatedInputTokens,
      streamStarted, failed, ...failureDetails(failure),
    }));
    return;
  }
  const costNanoUsd = actualCost(usage, active.rate);
  await context.ledger.recordUsage({
    usageEventId: active.usageEventId,
    month: active.month,
    modelId: active.modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costNanoUsd,
    occurredAt,
  });
  console.log(JSON.stringify({
    event: "model.cost.recorded",
    usageEventId: active.usageEventId,
    modelId: active.modelId,
    month: active.month,
    currency: "USD",
    catalogVersion: active.pricing.catalogVersion,
    catalogS3VersionId: active.pricing.catalogS3VersionId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    actualTokens: totalTokens(usage),
    inputNanoUsdPerMillionTokens: active.rate.inputPerMillionTokens.toString(),
    outputNanoUsdPerMillionTokens: active.rate.outputPerMillionTokens.toString(),
    contextTierMaxInputTokens: active.pricing.contextTierMaxInputTokens,
    costNanoUsd: costNanoUsd.toString(),
    actualUsd: Number(costNanoUsd) / 1_000_000_000,
    tokenCountSource: active.tokenCountSource,
    failed,
    calculatedAt: occurredAt.toISOString(),
  }));
}

async function recordAfterStream(
  active: ActiveUsage,
  usage: TokenUsage | undefined,
  context: BudgetContext,
  streamStarted: boolean,
  failure?: unknown,
): Promise<void> {
  try {
    await record(active, usage, context, failure !== undefined, streamStarted, failure);
  } catch (recordingError) {
    if (failure !== undefined) throw new AggregateError([failure, recordingError], "model call and usage recording both failed");
    throw recordingError;
  }
}

export class BudgetControlledBedrockModel extends BedrockModel {
  constructor(options: BedrockModelOptions, private readonly budget: BudgetContext) { super(options); }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const config = this.getConfig();
    if (!config.modelId) throw new Error("modelId is required for budget control");
    const active = await prepare(config.modelId, "bedrock", () => this.countTokens(messages, options), this.budget);
    let usage: TokenUsage | undefined;
    let streamStarted = false;
    try {
      for await (const event of super.stream(messages, options)) {
        streamStarted = true;
        if (event.type === "modelMetadataEvent" && event.usage) usage = event.usage;
        yield event;
      }
    } catch (error) {
      await recordAfterStream(active, usage, this.budget, streamStarted, error);
      throw error;
    }
    await recordAfterStream(active, usage, this.budget, streamStarted);
    if (!usage) throw new Error(`Bedrock usage was not returned: ${active.usageEventId}`);
  }
}

export class BudgetControlledGoogleModel extends GoogleModel {
  constructor(options: GoogleModelOptions, private readonly budget: BudgetContext) { super(options); }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const config = this.getConfig();
    if (!config.modelId) throw new Error("modelId is required for budget control");
    const active = await prepare(config.modelId, "google", () => this.countTokens(messages, options), this.budget);
    let usage: TokenUsage | undefined;
    let streamStarted = false;
    try {
      for await (const event of super.stream(messages, options)) {
        streamStarted = true;
        if (event.type === "modelMetadataEvent" && event.usage) usage = event.usage;
        yield event;
      }
    } catch (error) {
      await recordAfterStream(active, usage, this.budget, streamStarted, error);
      throw error;
    }
    await recordAfterStream(active, usage, this.budget, streamStarted);
    if (!usage) throw new Error(`Gemini usage was not returned: ${active.usageEventId}`);
  }
}
