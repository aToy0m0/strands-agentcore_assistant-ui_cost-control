import { describe, expect, it } from "vitest";
import { parseRuntimeConfig, runtimeInvocationUrl, type RuntimeConfig } from "../src/config.js";

const runtimeConfig = {
  environment: "test",
  debug: false,
  auth: {
    region: "us-east-1",
    userPoolId: "us-east-1_example",
    userPoolClientId: "client-id",
    cognitoDomain: "example.auth.us-east-1.amazoncognito.com",
    entraEnabled: false,
    entraProviderName: null,
    loginMethods: "cognito",
  },
  agent: {
    runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example",
    qualifier: "DEFAULT",
  },
};

describe("runtimeInvocationUrl", () => {
  it("Runtime ARNをURLエンコードして直接呼び出しURLを作る", () => {
    const config = {
      agent: { runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/example", qualifier: "DEFAULT" },
    } as RuntimeConfig;
    expect(runtimeInvocationUrl(config)).toBe("https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A123456789012%3Aruntime%2Fexample/invocations?qualifier=DEFAULT");
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
});
