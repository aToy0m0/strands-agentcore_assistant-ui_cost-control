import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { cdkArguments, validateDeployConfig } from "./deploy.mjs";

function config(overrides = {}) {
  return {
    profile: "cdkdep",
    region: "us-east-1",
    defaultCdkPrefix: "Sample-App",
    runtimeDisplayName: "Sample",
    webDebugMode: "off",
    customDomainEnabled: false,
    allowCrossRegionKnowledgeBases: false,
    knowledgeBases: [],
    gatewayTargets: [],
    geminiEnabled: false,
    enabledModelKeys: ["nova-2-lite"],
    modelIds: { "nova-2-lite": "us.amazon.nova-2-lite-v1:0" },
    entraEnabled: false,
    loginMethods: "cognito",
    logRetentionDays: 14,
    runtimeLogRequest: "off",
    runtimeLogModel: "off",
    runtimeLogTool: "on",
    monthlyBudgetUsd: "60",
    priceVerificationEnabled: false,
    ...overrides,
  };
}

describe("deployment config", () => {
  it("accepts a portable JSON configuration and encodes arrays", () => {
    const value = validateDeployConfig(config({ knowledgeBases: [{ key: "docs", enabled: false }] }));
    const args = cdkArguments(value, "diff");
    assert.deepEqual(args.slice(0, 8), ["run", "--silent", "cdk:diff", "--", "--profile", "cdkdep", "--region", "us-east-1"]);
    assert.ok(args.some((entry) => entry.startsWith("knowledgeBasesBase64=")));
    assert.ok(args.some((entry) => entry.startsWith("modelIdsBase64=")));
  });

  it("requires an explicit model ID for every enabled model", () => {
    assert.throws(() => validateDeployConfig(config({ modelIds: {} })), /modelIds\.nova-2-lite/u);
  });

  it("rejects profiles other than cdkdep", () => {
    assert.throws(() => validateDeployConfig(config({ profile: "admin" })), /profile must be cdkdep/u);
  });

  it("rejects unknown fields and missing conditional values", () => {
    assert.throws(() => validateDeployConfig(config({ unknown: true })), /unsupported fields/u);
    assert.throws(() => validateDeployConfig(config({ customDomainEnabled: true })), /customDomainName/u);
  });

  it("USと東京のサンプルJSONが同じ検証を通る", () => {
    for (const name of ["deploy-config.us-east-1.example.json", "deploy-config.ap-northeast-1.example.json"]) {
      assert.doesNotThrow(() => validateDeployConfig(JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"))));
    }
  });
});
