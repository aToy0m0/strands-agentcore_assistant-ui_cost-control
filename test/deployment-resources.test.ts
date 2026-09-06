import { describe, expect, it } from "vitest";
import {
  assertKnowledgeBaseRegions,
  parseEnabledModelKeys,
  parseGatewayLambdaTargets,
  parseKnowledgeBases,
} from "../shared/deployment-resources.js";

describe("deployment resource config", () => {
  it("複数Knowledge Baseを既定値込みで検証する", () => {
    expect(parseKnowledgeBases(JSON.stringify([
      { key: "docs-a", region: "us-east-1", knowledgeBaseId: "ABCDEFGHIJ", toolName: "search_docs_a", description: "Docs A" },
      { key: "docs-b", enabled: false, region: "ap-northeast-1", knowledgeBaseId: "KLMNOPQRST", toolName: "search_docs_b", description: "Docs B", numberOfResults: 7 },
    ]))).toEqual([
      { key: "docs-a", enabled: true, region: "us-east-1", knowledgeBaseId: "ABCDEFGHIJ", toolName: "search_docs_a", description: "Docs A", numberOfResults: 5 },
      { key: "docs-b", enabled: false, region: "ap-northeast-1", knowledgeBaseId: "KLMNOPQRST", toolName: "search_docs_b", description: "Docs B", numberOfResults: 7 },
    ]);
  });

  it("有効なtoolNameの重複とKnowledge Base全無効を拒否する", () => {
    expect(() => parseKnowledgeBases([
      { key: "docs-a", region: "us-east-1", knowledgeBaseId: "ABCDEFGHIJ", toolName: "search_docs", description: "A" },
      { key: "docs-b", region: "us-east-1", knowledgeBaseId: "KLMNOPQRST", toolName: "search_docs", description: "B" },
    ])).toThrow("tool names must be unique");
    expect(() => parseKnowledgeBases([
      { key: "docs-a", enabled: false, region: "us-east-1", knowledgeBaseId: "ABCDEFGHIJ", toolName: "search_docs", description: "A" },
    ])).toThrow("at least one enabled");
  });

  it("Knowledge Baseのリージョン越境を明示設定でだけ許可する", () => {
    const values = parseKnowledgeBases([
      { key: "tokyo-docs", region: "ap-northeast-1", knowledgeBaseId: "ABCDEFGHIJ", toolName: "search_tokyo_docs", description: "Tokyo" },
    ]);
    expect(() => assertKnowledgeBaseRegions(values, "us-east-1", false)).toThrow("AllowCrossRegionKnowledgeBases=true");
    expect(() => assertKnowledgeBaseRegions(values, "us-east-1", true)).not.toThrow();
  });

  it("Gateway Lambda targetの実行設定を検証する", () => {
    expect(parseGatewayLambdaTargets([{
      key: "support-directory",
      environmentVariables: { DIRECTORY_MODE: "readonly" },
    }])).toEqual([{
      key: "support-directory",
      enabled: true,
      timeoutSeconds: 5,
      memorySizeMb: 128,
      environmentVariables: { DIRECTORY_MODE: "readonly" },
    }]);
    expect(() => parseGatewayLambdaTargets([{
      key: "support-directory", memorySizeMb: 127,
    }])).toThrow("128 to 10240");
    expect(() => parseGatewayLambdaTargets([{
      key: "support-directory", environmentVariables: { "bad-name": "value" },
    }])).toThrow("invalid name");
  });

  it("配置環境で有効にするモデルをallowlistとして検証する", () => {
    expect(parseEnabledModelKeys('["bedrock-model","gemini-model"]', ["bedrock-model", "gemini-model"]))
      .toEqual(["bedrock-model", "gemini-model"]);
    expect(() => parseEnabledModelKeys(["unknown"], ["known"])).toThrow("unknown model key");
    expect(() => parseEnabledModelKeys([], ["known"])).toThrow("at least one model key");
  });
});
