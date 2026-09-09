import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCostStatus, nanoUsdToUsd, parseAwsJson, resolveCliOptions } from "./show-cost-status.mjs";

const n = (value) => ({ N: String(value) });
const s = (value) => ({ S: value });

describe("cost status", () => {
  it("月次費用、残額、モデル別内訳、記録状態を集計する", () => {
    const status = buildCostStatus({
      month: "2026-09",
      configurationItem: { limitNanoUsd: n(60_000_000_000n) },
      monthlyItem: { spentNanoUsd: n(1_500_000_000n) },
      usageItems: [
        { status: s("APPLIED"), modelId: s("model-a"), inputTokens: n(100), outputTokens: n(20), costNanoUsd: n(1_500_000_000n) },
        { status: s("NO_CHARGE"), modelId: s("model-a") },
        { status: s("USAGE_UNAVAILABLE"), modelId: s("model-b") },
      ],
    });
    assert.equal(status.spentNanoUsd, 1_500_000_000n);
    assert.equal(status.remainingNanoUsd, 58_500_000_000n);
    assert.equal(status.usagePercent, 2.5);
    assert.equal(status.ledgerMatchesEvents, true);
    assert.deepEqual(status.statusCounts, { APPLIED: 1, NO_CHARGE: 1, USAGE_UNAVAILABLE: 1 });
    assert.deepEqual(status.models[0], {
      modelId: "model-a", calls: 2, inputTokens: 100, outputTokens: 20, costNanoUsd: 1_500_000_000n,
    });
  });

  it("当月レコードがない場合は費用ゼロとして表示する", () => {
    const status = buildCostStatus({
      month: "2026-09",
      configurationItem: { limitNanoUsd: n(1_000_000_000n) },
      monthlyItem: undefined,
      usageItems: [],
    });
    assert.equal(status.spentNanoUsd, 0n);
    assert.equal(status.remainingNanoUsd, 1_000_000_000n);
    assert.equal(status.usagePercent, 0);
  });

  it("nano USDを丸めずUSD文字列へ変換する", () => {
    assert.equal(nanoUsdToUsd(1_234_567_890n), "1.23456789");
    assert.equal(nanoUsdToUsd(-500_000_000n), "-0.5");
  });

  it("消化率を小数第2位へ四捨五入する", () => {
    const status = buildCostStatus({
      month: "2026-09",
      configurationItem: { limitNanoUsd: n(60_000_000_000n) },
      monthlyItem: { spentNanoUsd: n(64_193_440n) },
      usageItems: [{ status: s("APPLIED"), modelId: s("model-a"), costNanoUsd: n(64_193_440n) }],
    });
    assert.equal(status.usagePercent, 0.11);
  });

  it("npmがオプション名を除いて渡した位置引数を受け付ける", () => {
    assert.deepEqual(
      resolveCliOptions(["us-east-1", "2026-08"], { npm_config_json: "true" }),
      { region: "us-east-1", stack: "agent-core-runtime-cost-control-stack", month: "2026-08", json: true },
    );
  });

  it("通常の名前付き引数を優先する", () => {
    assert.deepEqual(
      resolveCliOptions(["--region=ap-northeast-1", "--month=2026-07", "--json"], {}),
      { region: "ap-northeast-1", stack: "agent-core-runtime-cost-control-stack", month: "2026-07", json: true },
    );
  });

  it("DynamoDB get-itemの空出力を項目なしとして扱う", () => {
    assert.deepEqual(parseAwsJson(""), {});
    assert.deepEqual(parseAwsJson('{"Item":{"value":{"N":"1"}}}'), { Item: { value: { N: "1" } } });
  });
});
