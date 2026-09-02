import { Message, TextBlock } from "@strands-agents/sdk";
import { describe, expect, it, vi } from "vitest";
import { BudgetControlledBedrockModel, bedrockModelOptions } from "./model-factory.js";
import { BudgetExceededError, type DynamoBudgetLedger } from "./budget-ledger.js";
import { nanoUsdFromUsd } from "./cost.js";
import { modelByKey, parseInferenceSelection } from "../../shared/model-catalog.js";
import type { DynamoModelPricingCatalog, PricingRouting, PricingSnapshot } from "./pricing-catalog.js";

const region = "us-east-1";

function pricingCatalog(modelId: string, rate = { input: "0.3", output: "2.5" }) {
  const snapshot: PricingSnapshot = {
    modelId,
    version: "test-v1",
    verifiedAt: "2026-08-30T00:00:00.000Z",
    verifiedUntil: "2026-09-30T23:59:59.999Z",
    inputPerMillionTokens: nanoUsdFromUsd(rate.input),
    outputPerMillionTokens: nanoUsdFromUsd(rate.output),
  };
  return { requiredSnapshot: vi.fn(async (_modelId: string, _routing: PricingRouting) => snapshot) } as unknown as DynamoModelPricingCatalog;
}

it("usage-onlyモデルも入力検証を通す", () => {
  expect(parseInferenceSelection({ model: "nova-2-lite", reasoning: { enabled: false } }))
    .toEqual({ model: "nova-2-lite", reasoning: { enabled: false } });
});

it.each(["nova-2-lite", "claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "gpt-oss-20b", "gpt-oss-120b", "glm-4-7-flash", "glm-4-7"])(
  "%sは実績精算によるソフト制限を使う",
  (modelKey) => expect(modelByKey(modelKey).tokenCounter.kind).toBe("usage-only"),
);

describe("bedrockModelOptions", () => {
  it("enables Nova reasoning with the selected effort", () => {
    expect(bedrockModelOptions(region, { model: "nova-2-lite", reasoning: { enabled: true, effort: "medium" } })).toMatchObject({
      modelId: "us.amazon.nova-2-lite-v1:0",
      additionalRequestFields: { reasoningConfig: { type: "enabled", maxReasoningEffort: "medium" } },
    });
  });

  it("disables Nova reasoning explicitly", () => {
    expect(bedrockModelOptions(region, { model: "nova-2-lite", reasoning: { enabled: false } })).toMatchObject({
      additionalRequestFields: { reasoningConfig: { type: "disabled" } },
    });
  });

  it("maps Claude budget and adaptive reasoning", () => {
    expect(bedrockModelOptions(region, { model: "claude-haiku-4-5", reasoning: { enabled: true, effort: "low" } }).additionalRequestFields)
      .toEqual({ thinking: { type: "enabled", budget_tokens: 1_024 } });
    expect(bedrockModelOptions(region, { model: "claude-sonnet-4-6", reasoning: { enabled: true, effort: "high" } }).additionalRequestFields)
      .toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  });

  it("maps always-on Claude and GPT-OSS effort", () => {
    expect(bedrockModelOptions(region, { model: "claude-sonnet-5", reasoning: { enabled: true, effort: "medium" } }).additionalRequestFields)
      .toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
    expect(bedrockModelOptions(region, { model: "gpt-oss-120b", reasoning: { enabled: true, effort: "high" } }).additionalRequestFields)
      .toEqual({ reasoning_effort: "high" });
  });

  it("maps the off preference to the minimum effort for always-on models", () => {
    expect(bedrockModelOptions(region, { model: "claude-sonnet-5", reasoning: { enabled: false } }).additionalRequestFields)
      .toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(bedrockModelOptions(region, { model: "gpt-oss-20b", reasoning: { enabled: false } }).additionalRequestFields)
      .toEqual({ reasoning_effort: "low" });
  });

  it("maps GLM thinking without an effort field", () => {
    expect(bedrockModelOptions(region, { model: "glm-4-7-flash", reasoning: { enabled: true } }).additionalRequestFields)
      .toEqual({ thinking: { type: "enabled" } });
    expect(bedrockModelOptions(region, { model: "glm-4-7", reasoning: { enabled: false } }).additionalRequestFields)
      .toEqual({ thinking: { type: "disabled" } });
  });
});

describe("BudgetControlledBedrockModel", () => {
  it("CountTokens後の予約が失敗した場合はモデル呼び出しを開始しない", async () => {
    const countTokens = vi.fn(async () => 10);
    const reserve = vi.fn(async () => { throw new BudgetExceededError(); });
    const model = new BudgetControlledBedrockModel(
      { region, modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", stream: true, maxTokens: 100 },
      { count: countTokens },
      { reserve, settle: vi.fn() } as unknown as DynamoBudgetLedger,
      pricingCatalog("us.anthropic.claude-haiku-4-5-20251001-v1:0"),
      "geo-us",
      "user-1",
      { id: "default", default: true, window: "monthly", tokenLimit: 1_000_000 },
    );
    const consume = async () => {
      for await (const _event of model.stream([new Message({ role: "user", content: [new TextBlock("test")] })])) {
        // 予約失敗のためeventは到達しない。
      }
    };

    await expect(consume()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(countTokens).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      settlementMode: "bounded",
      user: expect.objectContaining({ actorId: "user-1", profileId: "default", tokenLimit: 1_000_000, maximumTokens: 110 }),
    }));
  });

  it("usage-onlyはCountTokensを呼ばず最大出力分だけ予約する", async () => {
    const reserve = vi.fn(async () => { throw new BudgetExceededError(); });
    const model = new BudgetControlledBedrockModel(
      { region, modelId: "us.amazon.nova-2-lite-v1:0", stream: true, maxTokens: 100 },
      undefined,
      { reserve, settle: vi.fn() } as unknown as DynamoBudgetLedger,
      pricingCatalog("us.amazon.nova-2-lite-v1:0"),
      "geo-us",
      "user-1",
      { id: "default", default: true, window: "monthly", tokenLimit: 1_000_000 },
    );
    const consume = async () => {
      for await (const _event of model.stream([new Message({ role: "user", content: [new TextBlock("test")] })])) {
        // 予約失敗のためeventは到達しない。
      }
    };

    await expect(consume()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      maximumNanoUsd: 250_000n,
      settlementMode: "usage-only",
      user: expect.objectContaining({ maximumTokens: 100 }),
    }));
  });
});
