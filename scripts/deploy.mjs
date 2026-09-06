import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, "..");

const allowedKeys = new Set([
  "profile", "region", "defaultCdkPrefix", "runtimeDisplayName", "webDebugMode",
  "customDomainEnabled", "customDomainName", "hostedZoneId", "hostedZoneName", "certificateArn",
  "allowCrossRegionKnowledgeBases", "knowledgeBases", "gatewayTargets", "geminiEnabled", "geminiApiKeySecretName",
  "enabledModelKeys", "entraEnabled", "entraTenantId", "entraClientId", "entraClientSecretName", "loginMethods",
  "logRetentionDays", "runtimeLogRequest", "runtimeLogModel", "runtimeLogTool", "monthlyBudgetUsd",
  "priceVerificationEnabled",
]);

const contextKeys = [
  "defaultCdkPrefix", "runtimeDisplayName", "webDebugMode", "customDomainEnabled",
  "customDomainName", "hostedZoneId", "hostedZoneName", "certificateArn", "allowCrossRegionKnowledgeBases",
  "geminiEnabled", "geminiApiKeySecretName", "entraEnabled", "entraTenantId", "entraClientId", "entraClientSecretName",
  "loginMethods", "logRetentionDays", "runtimeLogRequest", "runtimeLogModel", "runtimeLogTool", "monthlyBudgetUsd",
  "priceVerificationEnabled",
];

function object(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requiredString(config, name) {
  const value = config[name];
  if (typeof value !== "string" || !value.trim() || value.includes("<")) throw new Error(`${name} must contain an actual string value`);
  return value.trim();
}

function requiredBoolean(config, name) {
  if (typeof config[name] !== "boolean") throw new Error(`${name} must be true or false`);
}

function requiredArray(config, name) {
  if (!Array.isArray(config[name])) throw new Error(`${name} must be an array`);
}

export function validateDeployConfig(value) {
  const config = object(value, "deployment config");
  const unknown = Object.keys(config).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`deployment config contains unsupported fields: ${unknown.join(", ")}`);
  for (const name of ["profile", "region", "defaultCdkPrefix", "runtimeDisplayName", "webDebugMode", "loginMethods", "monthlyBudgetUsd"]) {
    requiredString(config, name);
  }
  if (config.profile !== "cdkdep") throw new Error("profile must be cdkdep for CDK operations");
  if (!/^[a-z]{2}-[a-z]+-\d$/u.test(config.region)) throw new Error("region must be an AWS region name");
  if (!/^[A-Za-z0-9 _-]{1,128}$/u.test(config.defaultCdkPrefix.trim())) throw new Error("defaultCdkPrefix is invalid");
  if (!/^(on|off)$/u.test(config.webDebugMode)) throw new Error("webDebugMode must be on or off");
  if (!/^\d+(\.\d{1,9})?$/u.test(config.monthlyBudgetUsd) || Number(config.monthlyBudgetUsd) <= 0) throw new Error("monthlyBudgetUsd must be greater than zero with at most 9 decimal places");
  for (const name of ["customDomainEnabled", "allowCrossRegionKnowledgeBases", "geminiEnabled", "entraEnabled", "priceVerificationEnabled"]) requiredBoolean(config, name);
  for (const name of ["knowledgeBases", "gatewayTargets", "enabledModelKeys"]) requiredArray(config, name);
  if (!Number.isInteger(config.logRetentionDays) || config.logRetentionDays <= 0) throw new Error("logRetentionDays must be a positive integer");
  for (const name of ["runtimeLogRequest", "runtimeLogModel", "runtimeLogTool"]) {
    if (!/^(on|off)$/u.test(config[name])) throw new Error(`${name} must be on or off`);
  }
  if (config.customDomainEnabled) {
    for (const name of ["customDomainName", "hostedZoneId", "hostedZoneName", "certificateArn"]) requiredString(config, name);
  }
  if (config.geminiEnabled) requiredString(config, "geminiApiKeySecretName");
  if (config.entraEnabled) {
    for (const name of ["entraTenantId", "entraClientId", "entraClientSecretName"]) requiredString(config, name);
  }
  return config;
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function cdkArguments(config, mode) {
  if (mode !== "diff" && mode !== "deploy") throw new Error("mode must be diff or deploy");
  const contexts = new Map();
  for (const key of contextKeys) {
    if (config[key] !== undefined && config[key] !== "") contexts.set(key, String(config[key]));
  }
  contexts.set("knowledgeBasesBase64", base64url(config.knowledgeBases));
  contexts.set("gatewayTargetsBase64", base64url(config.gatewayTargets));
  contexts.set("enabledModelKeysBase64", base64url(config.enabledModelKeys));
  const args = ["run", "--silent", mode === "diff" ? "cdk:diff" : "cdk:deploy", "--", "--profile", config.profile, "--region", config.region];
  for (const [key, value] of contexts) args.push("-c", `${key}=${value}`);
  return args;
}

function argumentsFrom(argv) {
  let configPath = resolve(scriptsDirectory, "deploy-config.json");
  let mode;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config") configPath = resolve(argv[++index] ?? "");
    else if (argv[index] === "--mode") mode = argv[++index];
    else throw new Error(`unsupported argument: ${argv[index]}`);
  }
  if (mode !== "diff" && mode !== "deploy") throw new Error("--mode must be diff or deploy");
  return { configPath, mode };
}

export function main(argv = process.argv.slice(2)) {
  const { configPath, mode } = argumentsFrom(argv);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (cause) {
    throw new Error(`deployment config could not be read: ${configPath}`, { cause });
  }
  const config = validateDeployConfig(parsed);
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("run this command through npm so the project-local npm executable is used");
  const result = spawnSync(process.execPath, [npmCli, ...cdkArguments(config, mode)], { cwd: projectRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CDK ${mode} failed with exit code ${result.status ?? "unknown"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
