import { Message, TextBlock } from "@strands-agents/sdk";
import { describe, expect, it, vi } from "vitest";
import { BudgetControlledBedrockModel, bedrockModelOptions, googleModelOptions, pricingRoutingFor, usageStatusWithoutUsage } from "./model-factory.js";
import { BudgetExceededError, type DynamoBudgetLedger } from "./budget-ledger.js";
import { nanoUsdFromUsd } from "./cost.js";
import { modelByKey, parseInferenceSelection } from "../../shared/model-catalog.js";
import type { PricingRouting, PricingSnapshot, S3ModelPricingCatalog } from "./pricing-catalog.js";

const region = "us-east-1";
const modelId = (key: string) => modelByKey(key).modelId;

function pricingCatalog(modelId: string, rate = { input: "0.3", output: "2.5" }) {
  const snapshot: PricingSnapshot = {
    modelId,
    catalogVersion: "test-v1",
    catalogS3VersionId: "s3-v1",
    verifiedAt: "2026-08-30T00:00:00.000Z",
    reviewDueAt: "2026-09-30T23:59:59.999Z",
    inputPerMillionTokens: nanoUsdFromUsd(rate.input),
    outputPerMillionTokens: nanoUsdFromUsd(rate.output),
  };
  return { requiredSnapshot: vi.fn(async (_modelId: string, _routing: PricingRouting) => snapshot) } as unknown as S3ModelPricingCatalog;
}

it("プロバイダー標準トークン計数モデルも入力検証を通す", () => {
  expect(parseInferenceSelection({ model: "nova-2-lite", reasoning: { enabled: false } }))
    .toEqual({ model: "nova-2-lite", reasoning: { enabled: false } });
});

it.each(["nova-2-lite", "claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "gpt-oss-20b", "gpt-oss-120b", "gpt-5-6-luna", "glm-4-7-flash", "glm-4-7", "gemini-3-5-flash"])(
  "%sはプロバイダー標準トークン計数とSDK推定を使う",
  (modelKey) => expect(modelByKey(modelKey).tokenCounter.kind).toBe("provider-native-with-estimate"),
);

describe("bedrockModelOptions", () => {
  it("enables Nova reasoning with the selected effort", () => {
    expect(bedrockModelOptions(region, { model: "nova-2-lite", reasoning: { enabled: true, effort: "medium" } }, modelId("nova-2-lite"))).toMatchObject({
      modelId: "us.amazon.nova-2-lite-v1:0",
      additionalRequestFields: { reasoningConfig: { type: "enabled", maxReasoningEffort: "medium" } },
    });
  });

  it("disables Nova reasoning explicitly", () => {
    expect(bedrockModelOptions(region, { model: "nova-2-lite", reasoning: { enabled: false } }, modelId("nova-2-lite"))).toMatchObject({
      additionalRequestFields: { reasoningConfig: { type: "disabled" } },
    });
  });

  it("maps Claude budget and adaptive reasoning", () => {
    expect(bedrockModelOptions(region, { model: "claude-haiku-4-5", reasoning: { enabled: true, effort: "low" } }, modelId("claude-haiku-4-5")).additionalRequestFields)
      .toEqual({ thinking: { type: "enabled", budget_tokens: 1_024 } });
    expect(bedrockModelOptions(region, { model: "claude-sonnet-4-6", reasoning: { enabled: true, effort: "high" } }, modelId("claude-sonnet-4-6")).additionalRequestFields)
      .toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  });

  it("maps always-on Claude and GPT-OSS effort", () => {
    expect(bedrockModelOptions(region, { model: "claude-sonnet-5", reasoning: { enabled: true, effort: "medium" } }, modelId("claude-sonnet-5")).additionalRequestFields)
      .toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
    expect(bedrockModelOptions(region, { model: "gpt-oss-120b", reasoning: { enabled: true, effort: "high" } }, modelId("gpt-oss-120b")).additionalRequestFields)
      .toEqual({ reasoning_effort: "high" });
  });

  it("GPT-5.6 LunaへGeo推論IDとreasoning effortを設定する", () => {
    expect(bedrockModelOptions(region, { model: "gpt-5-6-luna", reasoning: { enabled: true, effort: "medium" } }, modelId("gpt-5-6-luna"))).toMatchObject({
      modelId: "us.openai.gpt-5.6-luna",
      additionalRequestFields: { reasoning_effort: "medium" },
      useNativeTokenCount: true,
    });
  });

  it("maps the off preference to the minimum effort for always-on models", () => {
    expect(bedrockModelOptions(region, { model: "claude-sonnet-5", reasoning: { enabled: false } }, modelId("claude-sonnet-5")).additionalRequestFields)
      .toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(bedrockModelOptions(region, { model: "gpt-oss-20b", reasoning: { enabled: false } }, modelId("gpt-oss-20b")).additionalRequestFields)
      .toEqual({ reasoning_effort: "low" });
  });

  it("maps GLM thinking without an effort field", () => {
    expect(bedrockModelOptions(region, { model: "glm-4-7-flash", reasoning: { enabled: true } }, modelId("glm-4-7-flash")).additionalRequestFields)
      .toEqual({ thinking: { type: "enabled" } });
    expect(bedrockModelOptions(region, { model: "glm-4-7", reasoning: { enabled: false } }, modelId("glm-4-7")).additionalRequestFields)
      .toEqual({ thinking: { type: "disabled" } });
  });
});

describe("googleModelOptions", () => {
  it("Gemini 3.5 Flashへnative CountTokensと出力上限を設定する", () => {
    expect(googleModelOptions({ model: "gemini-3-5-flash", reasoning: { enabled: true, effort: "medium" } }, "test-key", modelId("gemini-3-5-flash")))
      .toMatchObject({
        modelId: "gemini-3.5-flash",
        maxTokens: 8_192,
        useNativeTokenCount: true,
        params: { maxOutputTokens: 8_192, thinkingConfig: { thinkingLevel: "MEDIUM", includeThoughts: true } },
      });
  });

  it("Reasoning無効時はGeminiの思考要約を返さずthinking levelを最小化する", () => {
    expect(googleModelOptions({ model: "gemini-3-5-flash", reasoning: { enabled: false } }, "test-key", modelId("gemini-3-5-flash")))
      .toMatchObject({
        params: { thinkingConfig: { thinkingLevel: "MINIMAL", includeThoughts: false } },
      });
  });
});

describe("pricingRoutingFor", () => {
  it("モデルIDのリージョン経路を区別する", () => {
    expect(pricingRoutingFor("us.openai.gpt-5.6-luna", "openai")).toBe("geo-us");
    expect(pricingRoutingFor("jp.amazon.nova-2-lite-v1:0", "amazon")).toBe("geo-jp");
    expect(pricingRoutingFor("global.anthropic.claude-sonnet-5", "anthropic")).toBe("global");
    expect(pricingRoutingFor("openai.gpt-oss-20b-1:0", "openai")).toBe("in-region");
  });
});

describe("BudgetControlledBedrockModel", () => {
  it("usage欠落を推論開始前と開始後で分類する", () => {
    expect(usageStatusWithoutUsage(true, false)).toBe("NO_CHARGE");
    expect(usageStatusWithoutUsage(true, true)).toBe("USAGE_UNAVAILABLE");
    expect(usageStatusWithoutUsage(false, true)).toBe("USAGE_UNAVAILABLE");
  });

  it("CountTokens後の事前判定が失敗した場合はモデル呼び出しを開始しない", async () => {
    const assertCanStart = vi.fn(async () => { throw new BudgetExceededError(); });
    const model = new BudgetControlledBedrockModel(
      { region, modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", stream: true, maxTokens: 100, useNativeTokenCount: true },
      {
        ledger: { assertCanStart, recordUsage: vi.fn(), recordUnpricedUsage: vi.fn() } as unknown as DynamoBudgetLedger,
        pricingCatalog: pricingCatalog("us.anthropic.claude-haiku-4-5-20251001-v1:0"),
        pricingRouting: "geo-us", pricingSourceRegion: region,
      },
    );
    const countTokens = vi.spyOn(model, "countTokens").mockResolvedValue(10);
    const consume = async () => {
      for await (const _event of model.stream([new Message({ role: "user", content: [new TextBlock("test")] })])) {
        // 事前判定失敗のためeventは到達しない。
      }
    };

    await expect(consume()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(countTokens).toHaveBeenCalledOnce();
    expect(assertCanStart).toHaveBeenCalledOnce();
  });

  it("最大出力費用や10%余裕を加えず入力見積りだけで判定する", async () => {
    const assertCanStart = vi.fn(async () => { throw new BudgetExceededError(); });
    const model = new BudgetControlledBedrockModel(
      { region, modelId: "us.amazon.nova-2-lite-v1:0", stream: true, maxTokens: 100, useNativeTokenCount: true },
      {
        ledger: { assertCanStart, recordUsage: vi.fn(), recordUnpricedUsage: vi.fn() } as unknown as DynamoBudgetLedger,
        pricingCatalog: pricingCatalog("us.amazon.nova-2-lite-v1:0"),
        pricingRouting: "geo-us", pricingSourceRegion: region,
      },
    );
    vi.spyOn(model, "countTokens").mockResolvedValue(10);
    const consume = async () => {
      for await (const _event of model.stream([new Message({ role: "user", content: [new TextBlock("test")] })])) {
        // 事前判定失敗のためeventは到達しない。
      }
    };

    await expect(consume()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(assertCanStart).toHaveBeenCalledWith(expect.any(String), 3_000n);
  });
});
