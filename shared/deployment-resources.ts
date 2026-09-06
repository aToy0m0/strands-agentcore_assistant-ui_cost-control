const KNOWLEDGE_BASE_ID_PATTERN = /^[0-9A-Z]{10}$/u;
const KEY_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;

export type KnowledgeBaseConfig = {
  key: string;
  enabled: boolean;
  region: string;
  knowledgeBaseId: string;
  toolName: string;
  description: string;
  numberOfResults: number;
};

export type GatewayLambdaTargetConfig = {
  key: string;
  enabled: boolean;
  timeoutSeconds: number;
  memorySizeMb: number;
  environmentVariables: Record<string, string>;
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function booleanValue(value: unknown, name: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function integerValue(value: unknown, name: string, defaultValue: number, minimum: number, maximum: number): number {
  const resolved = value === undefined ? defaultValue : value;
  if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function parseJsonArray(configured: unknown, name: string): unknown[] {
  let parsed = configured;
  if (typeof configured === "string") {
    try {
      parsed = JSON.parse(configured);
    } catch (error) {
      throw new Error(`${name} must be valid JSON`, { cause: error });
    }
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} must be an array`);
  return parsed;
}

function parseJsonRecord(configured: unknown, name: string): Record<string, unknown> {
  let parsed = configured;
  if (typeof configured === "string") {
    try {
      parsed = JSON.parse(configured);
    } catch (error) {
      throw new Error(`${name} must be valid JSON`, { cause: error });
    }
  }
  return record(parsed, name);
}

function assertUnique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name} must be unique`);
}

export function parseKnowledgeBases(configured: unknown): KnowledgeBaseConfig[] {
  const parsed = parseJsonArray(configured, "knowledgeBases").map((entry, index) => {
    const item = record(entry, `knowledgeBases[${index}]`);
    const key = stringValue(item.key, `knowledgeBases[${index}].key`);
    const region = stringValue(item.region, `knowledgeBases[${index}].region`);
    const knowledgeBaseId = stringValue(item.knowledgeBaseId, `knowledgeBases[${index}].knowledgeBaseId`);
    const toolName = stringValue(item.toolName, `knowledgeBases[${index}].toolName`);
    const description = stringValue(item.description, `knowledgeBases[${index}].description`);
    if (!KEY_PATTERN.test(key)) throw new Error(`knowledgeBases[${index}].key has an invalid format`);
    if (!REGION_PATTERN.test(region)) throw new Error(`knowledgeBases[${index}].region has an invalid format`);
    if (!KNOWLEDGE_BASE_ID_PATTERN.test(knowledgeBaseId)) throw new Error(`knowledgeBases[${index}].knowledgeBaseId must be a 10-character uppercase alphanumeric ID`);
    if (!TOOL_NAME_PATTERN.test(toolName)) throw new Error(`knowledgeBases[${index}].toolName has an invalid format`);
    return {
      key,
      enabled: booleanValue(item.enabled, `knowledgeBases[${index}].enabled`, true),
      region,
      knowledgeBaseId,
      toolName,
      description,
      numberOfResults: integerValue(item.numberOfResults, `knowledgeBases[${index}].numberOfResults`, 5, 1, 10),
    };
  });
  const enabled = parsed.filter((entry) => entry.enabled);
  if (enabled.length === 0) throw new Error("knowledgeBases must contain at least one enabled entry");
  assertUnique(parsed.map((entry) => entry.key), "knowledgeBases keys");
  assertUnique(enabled.map((entry) => entry.toolName), "enabled knowledgeBases tool names");
  return parsed;
}

export function assertKnowledgeBaseRegions(
  knowledgeBases: readonly KnowledgeBaseConfig[],
  deploymentRegion: string,
  allowCrossRegion: boolean,
): void {
  if (allowCrossRegion) return;
  const crossRegion = knowledgeBases.find((entry) => entry.enabled && entry.region !== deploymentRegion);
  if (crossRegion) {
    throw new Error(`knowledgeBases entry '${crossRegion.key}' uses ${crossRegion.region}; set AllowCrossRegionKnowledgeBases=true to allow cross-region retrieval`);
  }
}

export function parseGatewayLambdaTargets(configured: unknown): GatewayLambdaTargetConfig[] {
  const parsed = parseJsonArray(configured, "gatewayTargets").map((entry, index) => {
    const item = record(entry, `gatewayTargets[${index}]`);
    const key = stringValue(item.key, `gatewayTargets[${index}].key`);
    if (!KEY_PATTERN.test(key)) throw new Error(`gatewayTargets[${index}].key has an invalid format`);
    const environmentSource = item.environmentVariables === undefined
      ? {}
      : record(item.environmentVariables, `gatewayTargets[${index}].environmentVariables`);
    const environmentVariables = Object.fromEntries(Object.entries(environmentSource).map(([name, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) throw new Error(`gatewayTargets[${index}].environmentVariables contains invalid name '${name}'`);
      return [name, stringValue(value, `gatewayTargets[${index}].environmentVariables.${name}`)];
    }));
    return {
      key,
      enabled: booleanValue(item.enabled, `gatewayTargets[${index}].enabled`, true),
      timeoutSeconds: integerValue(item.timeoutSeconds, `gatewayTargets[${index}].timeoutSeconds`, 5, 1, 900),
      memorySizeMb: integerValue(item.memorySizeMb, `gatewayTargets[${index}].memorySizeMb`, 128, 128, 10_240),
      environmentVariables,
    };
  });
  assertUnique(parsed.map((entry) => entry.key), "gatewayTargets keys");
  return parsed;
}

export function parseEnabledModelKeys(configured: unknown, availableKeys: readonly string[]): string[] {
  const values = parseJsonArray(configured, "enabledModelKeys").map((value, index) => stringValue(value, `enabledModelKeys[${index}]`));
  if (values.length === 0) throw new Error("enabledModelKeys must contain at least one model key");
  assertUnique(values, "enabledModelKeys");
  const unknown = values.find((value) => !availableKeys.includes(value));
  if (unknown) throw new Error(`enabledModelKeys contains unknown model key '${unknown}'`);
  return values;
}

export function parseModelIds(
  configured: unknown,
  enabledModelKeys: readonly string[],
  availableKeys: readonly string[],
): Record<string, string> {
  const parsed = parseJsonRecord(configured, "modelIds");
  const unknown = Object.keys(parsed).find((key) => !availableKeys.includes(key));
  if (unknown) throw new Error(`modelIds contains unknown model key '${unknown}'`);
  const modelIds = Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
    const modelId = stringValue(value, `modelIds.${key}`);
    if (!/^[A-Za-z0-9._:-]+$/u.test(modelId)) throw new Error(`modelIds.${key} has an invalid format`);
    return [key, modelId];
  }));
  const missing = enabledModelKeys.find((key) => modelIds[key] === undefined);
  if (missing) throw new Error(`modelIds.${missing} is required because the model is enabled`);
  const duplicate = Object.entries(modelIds).find(([, modelId], index, entries) =>
    entries.findIndex(([, candidate]) => candidate === modelId) !== index);
  if (duplicate) throw new Error(`modelIds contains duplicate model ID '${duplicate[1]}'`);
  return modelIds;
}
