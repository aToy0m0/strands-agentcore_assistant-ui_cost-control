import { randomUUID } from "node:crypto";
import { BedrockModel, type BedrockModelOptions, type Message, type ModelStreamEvent, type StreamOptions } from "@strands-agents/sdk";
import type { DynamoBudgetLedger } from "./budget-ledger.js";
import { actualCost, maximumCost, totalTokens, utcMonth, type TokenUsage } from "./cost.js";
import { modelByKey, type InferenceSelection, type ReasoningEffort } from "../../shared/model-catalog.js";
import { userLimitWindowKey, type UserLimitProfile } from "../../shared/user-limit-profiles.js";
import { createTokenCounter, type FormattedBedrockRequest, type TokenCounter } from "./token-counter.js";
import { rateCard, type DynamoModelPricingCatalog, type PricingRouting } from "./pricing-catalog.js";

const CLAUDE_BUDGET: Record<ReasoningEffort, number> = {
  low: 1_024,
  medium: 4_096,
  high: 8_192,
};

function requiredEffort(selection: InferenceSelection): ReasoningEffort {
  if (!selection.reasoning.enabled || !selection.reasoning.effort) throw new Error(`${selection.model} requires reasoning effort`);
  return selection.reasoning.effort;
}

export function bedrockModelOptions(region: string, selection: InferenceSelection): BedrockModelOptions {
  const model = modelByKey(selection.model);
  const common: BedrockModelOptions = { region, modelId: model.modelId, stream: true, maxTokens: 4_096 };

  switch (model.requestAdapter) {
    case "nova-reasoning":
      return {
        ...common,
        additionalRequestFields: selection.reasoning.enabled
          ? { reasoningConfig: { type: "enabled", maxReasoningEffort: requiredEffort(selection) } }
          : { reasoningConfig: { type: "disabled" } },
      };
    case "claude-budget":
      return selection.reasoning.enabled
        ? { ...common, maxTokens: 16_000, additionalRequestFields: { thinking: { type: "enabled", budget_tokens: CLAUDE_BUDGET[requiredEffort(selection)] } } }
        : { ...common, maxTokens: 16_000 };
    case "claude-adaptive":
      return selection.reasoning.enabled
        ? { ...common, maxTokens: 16_000, additionalRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: requiredEffort(selection) } } }
        : { ...common, maxTokens: 16_000 };
    case "claude-always-on":
      return { ...common, maxTokens: 16_000, additionalRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: selection.reasoning.enabled ? requiredEffort(selection) : "low" } } };
    case "gpt-oss-reasoning":
      return { ...common, maxTokens: 16_000, additionalRequestFields: { reasoning_effort: selection.reasoning.enabled ? requiredEffort(selection) : "low" } };
    case "glm-thinking":
      return { ...common, maxTokens: 4_096, additionalRequestFields: { thinking: { type: selection.reasoning.enabled ? "enabled" : "disabled" } } };
  }
}

export function createBedrockModel(region: string, selection: InferenceSelection, ledger: DynamoBudgetLedger, pricingCatalog: DynamoModelPricingCatalog, actorId: string, userProfile: UserLimitProfile): BedrockModel {
  const model = modelByKey(selection.model);
  if (model.tokenCounter.kind === "unsupported") throw new Error(model.tokenCounter.reason);
  const tokenCounter = model.tokenCounter.kind === "usage-only" ? undefined : createTokenCounter(region, model.tokenCounter);
  return new BudgetControlledBedrockModel(bedrockModelOptions(region, selection), tokenCounter, ledger, pricingCatalog, model.pricingRouting, actorId, userProfile);
}

export class BudgetControlledBedrockModel extends BedrockModel {
  constructor(
    options: BedrockModelOptions,
    private readonly tokenCounter: TokenCounter | undefined,
    private readonly ledger: DynamoBudgetLedger,
    private readonly pricingCatalog: DynamoModelPricingCatalog,
    private readonly pricingRouting: PricingRouting,
    private readonly actorId: string,
    private readonly userProfile: UserLimitProfile,
  ) { super(options); }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const config = this.getConfig();
    if (!config.modelId || !config.maxTokens) throw new Error("modelId and maxTokens are required for budget control");
    const pricing = await this.pricingCatalog.requiredSnapshot(config.modelId, this.pricingRouting);
    const rate = rateCard(pricing);
    const inputTokens = this.tokenCounter ? await this.strictCountTokens(messages, options) : 0;
    const maximumTokens = inputTokens + config.maxTokens;
    if (!Number.isSafeInteger(maximumTokens)) throw new Error("maximum token reservation exceeds the safe integer range");
    const reservation = await this.ledger.reserve({
      requestId: randomUUID(), month: utcMonth(), modelId: config.modelId,
      maximumNanoUsd: maximumCost(inputTokens, config.maxTokens, rate),
      settlementMode: this.tokenCounter ? "bounded" : "usage-only",
      pricing,
      user: {
        actorId: this.actorId,
        profileId: this.userProfile.id,
        window: `${this.userProfile.window}#${userLimitWindowKey(this.userProfile.window)}`,
        tokenLimit: this.userProfile.tokenLimit,
        maximumTokens,
      },
    });
    let usage: TokenUsage | undefined;
    for await (const event of super.stream(messages, options)) {
      if (event.type === "modelMetadataEvent" && event.usage) usage = event.usage;
      yield event;
    }
    if (!usage) throw new Error(`Bedrock usage was not returned; reservation remains active: ${reservation.requestId}`);
    await this.ledger.settle(reservation.requestId, actualCost(usage, rate), totalTokens(usage));
  }

  private async strictCountTokens(messages: Message[], options?: StreamOptions): Promise<number> {
    // SDK標準countTokensは失敗時に推定へfallbackするため、費用上限用途では使用しない。
    const formatter = (this as unknown as { _formatRequest?: (messages: Message[], options?: StreamOptions) => FormattedBedrockRequest })._formatRequest;
    if (typeof formatter !== "function") throw new Error("Strands Bedrock request formatter is unavailable");
    const request = formatter.call(this, messages, options);
    if (!this.tokenCounter) throw new Error("Preflight token counter is unavailable");
    return this.tokenCounter.count(request);
  }
}
