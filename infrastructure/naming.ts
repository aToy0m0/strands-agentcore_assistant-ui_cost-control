import { createHash } from "node:crypto";
import { Aws, Fn } from "aws-cdk-lib";

const MAX_BASE_LENGTH = 32;

export type ResourceNames = {
  base: string;
  stackName: string;
  userPoolName: string;
  userPoolClientName: string;
  runtimeName: string;
  memoryName: string;
  gatewayName: string;
  kmsMemoryAlias: string;
  metricNamespace: string;
  dashboardName: string;
  memoryNamespacePrefix: string;
  applicationName: string;
  runtimeLogGroupName: string;
  pricingVerifierLogGroupName: string;
  gatewayToolLogGroupName: (toolKey: string) => string;
  gatewayToolFunctionName: (suffix: string) => string;
};

function shortenBase(value: string): string {
  if (value.length <= MAX_BASE_LENGTH) return value;
  const hash = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
  const readable = value.slice(0, MAX_BASE_LENGTH - hash.length - 1).replace(/-+$/u, "");
  return `${readable}-${hash}`;
}

function suffix(base: string, value: string, maxLength: number): string {
  const result = `${base}-${value}`;
  if (result.length > maxLength) throw new Error(`generated resource name exceeds ${maxLength} characters: ${result}`);
  return result;
}

export function resolveResourceNames(configured: unknown): ResourceNames {
  if (typeof configured !== "string") throw new Error("defaultCdkPrefix is required");
  const input = configured.trim();
  if (!input || input.length > 128 || !/^[A-Za-z0-9 _-]+$/u.test(input)) {
    throw new Error("defaultCdkPrefix must be 1-128 ASCII letters, numbers, spaces, hyphens, or underscores");
  }
  const normalized = input
    .toLowerCase()
    .replace(/[ _-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!normalized) throw new Error("defaultCdkPrefix must contain a letter or number");
  const startsWithLetter = /^[a-z]/u.test(normalized) ? normalized : `app-${normalized}`;
  const base = shortenBase(startsWithLetter);
  const snake = base.replace(/-/gu, "_");

  return {
    base,
    stackName: suffix(base, "stack", 128),
    userPoolName: suffix(base, "users", 128),
    userPoolClientName: suffix(base, "web", 128),
    runtimeName: `${snake}_runtime`,
    memoryName: `${snake}_memory`,
    gatewayName: suffix(base, "tools", 100),
    kmsMemoryAlias: `alias/${suffix(base, "memory", 250)}`,
    metricNamespace: base,
    dashboardName: suffix(base, "model-cost", 255),
    memoryNamespacePrefix: `/${base}`,
    applicationName: suffix(base, "runtime", 64),
    runtimeLogGroupName: `/${base}/runtime`,
    pricingVerifierLogGroupName: `/${base}/pricing-verifier`,
    gatewayToolLogGroupName: (toolKey) => `/${base}/tools/${toolKey}`,
    gatewayToolFunctionName: (functionSuffix) => suffix(base, functionSuffix, 64),
  };
}

export function resolveRuntimeDisplayName(configured: unknown): string {
  if (typeof configured !== "string") throw new Error("runtimeDisplayName is required");
  const value = configured.trim();
  if (!value || value.length > 64 || Array.from(value).some((character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127)) {
    throw new Error("runtimeDisplayName must be 1-64 visible characters");
  }
  return value;
}

/** 同一CloudFormationスタックの更新中は不変で、削除・再作成時に変わるUUID先頭8文字。 */
export function stackInstanceSuffix(): string {
  const stackUuid = Fn.select(2, Fn.split("/", Aws.STACK_ID));
  return Fn.select(0, Fn.split("-", stackUuid));
}

export function cognitoDomainPrefix(names: ResourceNames): string {
  return Fn.join("-", [names.base, stackInstanceSuffix()]);
}
