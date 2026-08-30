import { Message, TextBlock } from "@strands-agents/sdk";
import { describe, expect, it, vi } from "vitest";
import { BudgetControlledBedrockModel, bedrockModelOptions } from "./model-factory.js";
import { BudgetExceededError, type DynamoBudgetLedger } from "./budget-ledger.js";
import { nanoUsdFromUsd } from "./cost.js";
import { parseInferenceSelection } from "../../shared/model-catalog.js";

const region = "us-east-1";

it("CountTokens非対応モデルは入力検証で拒否する", () => {
  expect(() => parseInferenceSelection({ model: "nova-2-lite", reasoning: { enabled: false } }))
    .toThrow("exact preflight token counting is unavailable");
});

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
      { inputPerMillionTokens: nanoUsdFromUsd("0.3"), outputPerMillionTokens: nanoUsdFromUsd("2.5") },
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
      user: expect.objectContaining({ actorId: "user-1", profileId: "default", tokenLimit: 1_000_000, maximumTokens: 110 }),
    }));
  });
});
