import { Amplify } from "aws-amplify";

import { parseEnabledModelKeys } from "../shared/deployment-resources.js";
import {
  isLoginMethods,
  showsCognitoLogin as showsCognitoFor,
  showsEntraLogin as showsEntraFor,
  LOGIN_METHOD_VALUES,
  type LoginMethods,
} from "../shared/login-methods.js";
import { MODEL_CATALOG } from "../shared/model-catalog.js";

export type { LoginMethods };

type RuntimeAgentBase = {
  id: string;
  name: string;
  description: string;
  qualifier: string;
};

export type RuntimeAgent = RuntimeAgentBase & ({
  runtimeArn: string;
} | {
  runtimeId: string;
  region: string;
  accountId: string;
});

export type RuntimeConfig = {
  environment: string;
  debug: boolean;
  ui: { name: string };
  auth: {
    region: string;
    userPoolId: string;
    userPoolClientId: string;
    cognitoDomain: string;
    entraEnabled: boolean;
    entraProviderName: string | null;
    loginMethods: LoginMethods;
  };
  defaultAgentId: string;
  agents: RuntimeAgent[];
  features: { enabledModelKeys: string[] };
};

export function showsCognitoLogin(config: RuntimeConfig): boolean {
  return showsCognitoFor(config.auth.loginMethods);
}

export function showsEntraLogin(config: RuntimeConfig): boolean {
  return showsEntraFor(config.auth.loginMethods);
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function parseAgent(value: unknown, index: number): RuntimeAgent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`agents[${index}] must be an object`);
  const agent = value as Record<string, unknown>;
  const id = required(agent.id, `agents[${index}].id`);
  if (!/^[a-z][a-z0-9-]{0,39}$/u.test(id)) throw new Error(`agents[${index}].id has an invalid format`);
  const base = {
    id,
    name: required(agent.name, `agents[${index}].name`),
    description: required(agent.description, `agents[${index}].description`),
    qualifier: required(agent.qualifier, `agents[${index}].qualifier`),
  };
  const hasRuntimeArn = agent.runtimeArn !== undefined;
  const hasRuntimeId = agent.runtimeId !== undefined;
  if (hasRuntimeArn === hasRuntimeId) throw new Error(`agents[${index}] must specify exactly one of runtimeArn or runtimeId`);
  if (hasRuntimeArn) {
    if (agent.region !== undefined || agent.accountId !== undefined) {
      throw new Error(`agents[${index}] must not specify region or accountId with runtimeArn`);
    }
    const runtimeArn = required(agent.runtimeArn, `agents[${index}].runtimeArn`);
    if (!/^arn:aws(?:-[^:]+)?:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[A-Za-z][A-Za-z0-9_]{0,47}-[A-Za-z0-9]{10}$/u.test(runtimeArn)) {
      throw new Error(`agents[${index}].runtimeArn must be an AgentCore Runtime ARN`);
    }
    return { ...base, runtimeArn };
  }
  const runtimeId = required(agent.runtimeId, `agents[${index}].runtimeId`);
  const region = required(agent.region, `agents[${index}].region`);
  const accountId = required(agent.accountId, `agents[${index}].accountId`);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,99}-[A-Za-z0-9]{10}$/u.test(runtimeId)) throw new Error(`agents[${index}].runtimeId has an invalid format`);
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(region)) throw new Error(`agents[${index}].region has an invalid format`);
  if (!/^\d{12}$/u.test(accountId)) throw new Error(`agents[${index}].accountId must be a 12-digit AWS account ID`);
  return { ...base, runtimeId, region, accountId };
}

export function parseRuntimeConfig(input: unknown): RuntimeConfig {
  if (typeof input !== "object" || input === null) throw new Error("runtime-config.json must be an object");
  const value = input as RuntimeConfig;
  if (typeof value.debug !== "boolean") throw new Error("debug must be a boolean");
  required(value.ui?.name, "ui.name");
  required(value.auth?.region, "auth.region");
  required(value.auth?.userPoolId, "auth.userPoolId");
  required(value.auth?.userPoolClientId, "auth.userPoolClientId");
  required(value.auth?.cognitoDomain, "auth.cognitoDomain");
  if (!Array.isArray(value.agents) || value.agents.length === 0) throw new Error("agents must contain at least one Runtime");
  const agents = value.agents.map(parseAgent);
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length) throw new Error("agents must have unique IDs");
  const defaultAgentId = required(value.defaultAgentId, "defaultAgentId");
  if (!agents.some((agent) => agent.id === defaultAgentId)) throw new Error("defaultAgentId must reference an agent");
  const enabledModelKeys = parseEnabledModelKeys(value.features?.enabledModelKeys, MODEL_CATALOG.map((model) => model.key));
  if (typeof value.auth.entraEnabled !== "boolean") throw new Error("auth.entraEnabled must be a boolean");
  if (value.auth.entraEnabled && !value.auth.entraProviderName) throw new Error("auth.entraProviderName is required when Entra is enabled");
  if (!isLoginMethods(value.auth.loginMethods)) {
    throw new Error(`auth.loginMethods must be one of: ${LOGIN_METHOD_VALUES.join(", ")}`);
  }
  if (value.auth.loginMethods !== "cognito" && !value.auth.entraEnabled) {
    throw new Error(`auth.loginMethods=${value.auth.loginMethods} requires auth.entraEnabled`);
  }
  return { ...value, defaultAgentId, agents, features: { enabledModelKeys } };
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

export function runtimeInvocationUrl(agent: RuntimeAgent): string {
  if ("runtimeArn" in agent) {
    const region = agent.runtimeArn.split(":")[3];
    if (!region) throw new Error("AgentCore Runtime ARNからリージョンを取得できません");
    return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(agent.runtimeArn)}/invocations?qualifier=${encodeURIComponent(agent.qualifier)}`;
  }
  return `https://bedrock-agentcore.${agent.region}.amazonaws.com/runtimes/${agent.runtimeId}/invocations?accountId=${agent.accountId}&qualifier=${encodeURIComponent(agent.qualifier)}`;
}
