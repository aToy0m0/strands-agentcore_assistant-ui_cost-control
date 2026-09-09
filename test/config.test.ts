import { describe, expect, it } from "vitest";
import { parseRuntimeConfig, runtimeInvocationUrl, type RuntimeConfig } from "../src/config.js";

const runtimeConfig = {
  environment: "test",
  debug: false,
  ui: { name: "AIエージェント" },
  auth: {
    region: "us-east-1",
    userPoolId: "us-east-1_example",
    userPoolClientId: "client-id",
    cognitoDomain: "example.auth.us-east-1.amazoncognito.com",
    entraEnabled: false,
    entraProviderName: null,
    loginMethods: "cognito",
  },
  defaultAgentId: "primary",
  agents: [{
    id: "primary",
    name: "Main agent",
    description: "Primary runtime",
    runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example-AbCdEf1234",
    qualifier: "DEFAULT",
  }],
  features: { enabledModelKeys: ["nova-2-lite"] },
};

describe("runtimeInvocationUrl", () => {
  it("Runtime ARNをURLエンコードして直接呼び出しURLを作る", () => {
    const agent = runtimeConfig.agents[0] as RuntimeConfig["agents"][number];
    expect(runtimeInvocationUrl(agent)).toBe("https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A123456789012%3Aruntime%2Fexample-AbCdEf1234/invocations?qualifier=DEFAULT");
  });
});

describe("parseRuntimeConfig", () => {
  it("debugのbooleanを受け付ける", () => {
    expect(parseRuntimeConfig({ ...runtimeConfig, debug: true }).debug).toBe(true);
    expect(parseRuntimeConfig(runtimeConfig).debug).toBe(false);
  });

  it("debugが未指定またはboolean以外なら拒否する", () => {
    const withoutDebug: Record<string, unknown> = { ...runtimeConfig };
    delete withoutDebug.debug;
    expect(() => parseRuntimeConfig(withoutDebug)).toThrow("debug must be a boolean");
    expect(() => parseRuntimeConfig({ ...runtimeConfig, debug: "on" })).toThrow("debug must be a boolean");
  });

  it("UI名を必須とする", () => {
    expect(parseRuntimeConfig(runtimeConfig).ui.name).toBe("AIエージェント");
    expect(() => parseRuntimeConfig({ ...runtimeConfig, ui: { name: "" } })).toThrow("ui.name is required");
  });

  it("複数Runtimeと既定Runtimeを検証する", () => {
    const additional = {
      id: "secondary",
      name: "Secondary",
      description: "Secondary runtime",
      runtimeId: "secondary-ZyXwVu9876",
      region: "ap-northeast-1",
      accountId: "123456789012",
      qualifier: "DEFAULT",
    };
    expect(parseRuntimeConfig({ ...runtimeConfig, agents: [...runtimeConfig.agents, additional] }).agents).toHaveLength(2);
    expect(() => parseRuntimeConfig({ ...runtimeConfig, defaultAgentId: "missing" })).toThrow("defaultAgentId");
    expect(() => parseRuntimeConfig({ ...runtimeConfig, agents: [...runtimeConfig.agents, { ...additional, id: "primary" }] })).toThrow("unique IDs");
  });

  it("Runtime IDとaccountIdを使う直接呼び出しURLを作る", () => {
    const agent = parseRuntimeConfig({
      ...runtimeConfig,
      defaultAgentId: "secondary",
      agents: [{
        id: "secondary",
        name: "Secondary",
        description: "Secondary runtime",
        runtimeId: "secondary-ZyXwVu9876",
        region: "ap-northeast-1",
        accountId: "123456789012",
        qualifier: "DEFAULT",
      }],
    }).agents[0];
    expect(runtimeInvocationUrl(agent)).toBe("https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/secondary-ZyXwVu9876/invocations?accountId=123456789012&qualifier=DEFAULT");
  });

  it("有効モデルキーを非空配列で必須にする", () => {
    expect(parseRuntimeConfig({ ...runtimeConfig, features: { enabledModelKeys: ["gemini-3-5-flash"] } }).features.enabledModelKeys)
      .toEqual(["gemini-3-5-flash"]);
    expect(() => parseRuntimeConfig({ ...runtimeConfig, features: { enabledModelKeys: [] } })).toThrow("enabledModelKeys");
    expect(() => parseRuntimeConfig({ ...runtimeConfig, features: { enabledModelKeys: ["unknown-model"] } })).toThrow("unknown model key");
  });
});
