import { describe, expect, it } from "vitest";
import { actualCost, maximumCost, nanoUsdFromUsd, utcMonth } from "./cost.js";

const rate = { inputPerMillionTokens: nanoUsdFromUsd("3"), outputPerMillionTokens: nanoUsdFromUsd("15") };

describe("LLM cost", () => {
  it("最大出力tokenを呼び出し前費用へ含める", () => expect(maximumCost(1_000, 2_000, rate)).toBe(nanoUsdFromUsd("0.033")));
  it("実usageをnano USDへ切り上げて計算する", () => {
    expect(actualCost({ inputTokens: 500, outputTokens: 200 }, rate)).toBe(nanoUsdFromUsd("0.0045"));
    expect(actualCost({ inputTokens: 1, outputTokens: 0 }, rate)).toBe(3_000n);
  });
  it("未設定のprompt cache単価を黙って代用しない", () => {
    expect(() => actualCost({ inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 }, rate)).toThrow("prompt-cache pricing is not configured");
  });
  it("AWS請求期間と同じUTC月を使う", () => {
    expect(utcMonth(new Date("2026-08-31T23:59:59.999Z"))).toBe("2026-08");
    expect(utcMonth(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09");
  });
});
