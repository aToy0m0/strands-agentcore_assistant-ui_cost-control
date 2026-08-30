import { Amplify } from "aws-amplify";

import {
  isLoginMethods,
  showsCognitoLogin as showsCognitoFor,
  showsEntraLogin as showsEntraFor,
  LOGIN_METHOD_VALUES,
  type LoginMethods,
} from "../shared/login-methods.js";

export type { LoginMethods };

export type RuntimeConfig = {
  environment: string;
  debug: boolean;
  auth: {
    region: string;
    userPoolId: string;
    userPoolClientId: string;
    cognitoDomain: string;
    entraEnabled: boolean;
    entraProviderName: string | null;
    loginMethods: LoginMethods;
  };
  agent: { runtimeArn: string; qualifier: string };
};

export function showsCognitoLogin(config: RuntimeConfig): boolean {
  return showsCognitoFor(config.auth.loginMethods);
}

export function showsEntraLogin(config: RuntimeConfig): boolean {
  return showsEntraFor(config.auth.loginMethods);
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

export function parseRuntimeConfig(input: unknown): RuntimeConfig {
  if (typeof input !== "object" || input === null) throw new Error("runtime-config.json must be an object");
  const value = input as RuntimeConfig;
  if (typeof value.debug !== "boolean") throw new Error("debug must be a boolean");
  required(value.auth?.region, "auth.region");
  required(value.auth?.userPoolId, "auth.userPoolId");
  required(value.auth?.userPoolClientId, "auth.userPoolClientId");
  required(value.auth?.cognitoDomain, "auth.cognitoDomain");
  required(value.agent?.runtimeArn, "agent.runtimeArn");
  required(value.agent?.qualifier, "agent.qualifier");
  if (typeof value.auth.entraEnabled !== "boolean") throw new Error("auth.entraEnabled must be a boolean");
  if (value.auth.entraEnabled && !value.auth.entraProviderName) throw new Error("auth.entraProviderName is required when Entra is enabled");
  if (!isLoginMethods(value.auth.loginMethods)) {
    throw new Error(`auth.loginMethods must be one of: ${LOGIN_METHOD_VALUES.join(", ")}`);
  }
  if (value.auth.loginMethods !== "cognito" && !value.auth.entraEnabled) {
    throw new Error(`auth.loginMethods=${value.auth.loginMethods} requires auth.entraEnabled`);
  }
  return value;
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const response = await fetch("/runtime-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`runtime-config.jsonの取得に失敗しました (${response.status})`);
  return parseRuntimeConfig(await response.json());
}

export function configureAmplify(config: RuntimeConfig) {
  const redirectUrl = `${window.location.origin}/`;
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.auth.userPoolId,
        userPoolClientId: config.auth.userPoolClientId,
        loginWith: {
          email: true,
          oauth: {
            domain: config.auth.cognitoDomain,
            scopes: ["openid", "email", "profile"],
            redirectSignIn: [redirectUrl],
            redirectSignOut: [redirectUrl],
            responseType: "code",
          },
        },
      },
    },
  });
}

export function runtimeInvocationUrl(config: RuntimeConfig): string {
  const region = config.agent.runtimeArn.split(":")[3];
  if (!region) throw new Error("AgentCore Runtime ARNからリージョンを取得できません");
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(config.agent.runtimeArn)}/invocations?qualifier=${encodeURIComponent(config.agent.qualifier)}`;
}
