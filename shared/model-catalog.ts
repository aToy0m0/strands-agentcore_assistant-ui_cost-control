export type ReasoningEffort = "low" | "medium" | "high";
export type ReasoningControl = "optional" | "always-on";
export type ReasoningVisibility = "redacted" | "summary" | "full";
export type ModelProvider = "amazon" | "anthropic" | "openai" | "zai";
export type TokenCounter =
  | { kind: "bedrock-runtime"; modelId: string }
  | { kind: "bedrock-mantle-anthropic"; modelId: string }
  | { kind: "usage-only" }
  | { kind: "unsupported"; reason: string };

export type ModelCatalogEntry = {
  key: string;
  label: string;
  provider: ModelProvider;
  modelId: string;
  availabilityModelId: string;
  foundationModelIds: readonly string[];
  tokenCounter: TokenCounter;
  pricingRouting: "geo-us" | "in-region";
  requestAdapter: "nova-reasoning" | "claude-budget" | "claude-adaptive" | "claude-always-on" | "gpt-oss-reasoning" | "glm-thinking";
  reasoning: {
    control: ReasoningControl;
    efforts: readonly ReasoningEffort[];
    contentVisibility: ReasoningVisibility;
  };
};

const efforts = ["low", "medium", "high"] as const;

export const MODEL_CATALOG = [
  {
    key: "nova-2-lite",
    label: "Amazon Nova 2 Lite",
    provider: "amazon",
    modelId: "us.amazon.nova-2-lite-v1:0",
    availabilityModelId: "amazon.nova-2-lite-v1:0",
    foundationModelIds: ["amazon.nova-2-lite-v1:0"],
    tokenCounter: { kind: "usage-only" },
    pricingRouting: "geo-us",
    requestAdapter: "nova-reasoning",
    reasoning: { control: "optional", efforts, contentVisibility: "redacted" },
  },
  {
    key: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    availabilityModelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
    foundationModelIds: ["anthropic.claude-haiku-4-5-20251001-v1:0"],
    tokenCounter: { kind: "usage-only" },
    pricingRouting: "geo-us",
    requestAdapter: "claude-budget",
    reasoning: { control: "optional", efforts, contentVisibility: "summary" },
  },
  {
    key: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    modelId: "us.anthropic.claude-sonnet-4-6",
    availabilityModelId: "anthropic.claude-sonnet-4-6",
    foundationModelIds: ["anthropic.claude-sonnet-4-6"],
    tokenCounter: { kind: "usage-only" },
    pricingRouting: "geo-us",
    requestAdapter: "claude-adaptive",
    reasoning: { control: "optional", efforts, contentVisibility: "summary" },
  },
  {
    key: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "anthropic",
    modelId: "us.anthropic.claude-sonnet-5",
    availabilityModelId: "anthropic.claude-sonnet-5",
    foundationModelIds: ["anthropic.claude-sonnet-5"],
    tokenCounter: { kind: "usage-only" },
    pricingRouting: "geo-us",
    requestAdapter: "claude-always-on",
    reasoning: { control: "always-on", efforts, contentVisibility: "summary" },
  },
  {
    key: "gpt-oss-20b",
    label: "GPT-OSS 20B",
    provider: "openai",
    modelId: "openai.gpt-oss-20b-1:0",
    availabilityModelId: "openai.gpt-oss-20b-1:0",
    foundationModelIds: ["openai.gpt-oss-20b-1:0"],
    tokenCounter: { kind: "usage-only" },
    pricingRouting: "in-region",
    requestAdapter: "gpt-oss-reasoning",
    reasoning: { control: "always-on", efforts, contentVisibility: "full" },
  },
  {
    key: "gpt-oss-120b",
    label: "GPT-OSS 120B",
    provider: "openai",
    modelId: "openai.gpt-oss-120b-1:0",
    availabilityModelId: "openai.gpt-oss-120b-1:0",
    foundationModelIds: ["openai.gpt-oss-120b-1:0"],
    tokenCounter: { kind: "usage-only" },
    pricingRouting: "in-region",
    requestAdapter: "gpt-oss-reasoning",
    reasoning: { control: "always-on", efforts, contentVisibility: "full" },
  },
  {
    key: "glm-4-7-flash",
    label: "GLM 4.7 Flash",
    provider: "zai",
    modelId: "zai.glm-4.7-flash",
    availabilityModelId: "zai.glm-4.7-flash",
    foundationModelIds: ["zai.glm-4.7-flash"],
    tokenCounter: { kind: "usage-only" },
    pricingRouting: "in-region",
    requestAdapter: "glm-thinking",
    reasoning: { control: "optional", efforts: [], contentVisibility: "full" },
  },
  {
    key: "glm-4-7",
    label: "GLM 4.7",
    provider: "zai",
    modelId: "zai.glm-4.7",
    availabilityModelId: "zai.glm-4.7",
    foundationModelIds: ["zai.glm-4.7"],
    tokenCounter: { kind: "usage-only" },
    pricingRouting: "in-region",
    requestAdapter: "glm-thinking",
    reasoning: { control: "optional", efforts: [], contentVisibility: "full" },
  },
] as const satisfies readonly ModelCatalogEntry[];

export const DEFAULT_INFERENCE_SELECTION = {
  model: "claude-haiku-4-5",
  reasoning: { enabled: true, effort: "medium" as ReasoningEffort },
} as const;

export type InferenceSelection = {
  model: string;
  reasoning: { enabled: false } | { enabled: true; effort?: ReasoningEffort };
};

export const COST_CONTROLLED_MODEL_CATALOG = MODEL_CATALOG;

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  const unknownKeys = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknownKeys.length) throw new Error(`${name} contains unsupported fields: ${unknownKeys.join(", ")}`);
}

export function parseInferenceSelection(value: unknown): InferenceSelection {
  const inference = object(value, "forwardedProps.inference");
  exactKeys(inference, ["model", "reasoning"], "forwardedProps.inference");
  if (typeof inference.model !== "string") throw new Error("forwardedProps.inference.model must be a string");
  const model = modelByKey(inference.model);
  if (model.tokenCounter.kind === "unsupported") {
    throw new Error(`Model is disabled because exact preflight token counting is unavailable: ${model.key}`);
  }
  const reasoning = object(inference.reasoning, "forwardedProps.inference.reasoning");
  exactKeys(reasoning, ["enabled", "effort"], "forwardedProps.inference.reasoning");
  if (typeof reasoning.enabled !== "boolean") throw new Error("forwardedProps.inference.reasoning.enabled must be a boolean");
  if (!reasoning.enabled) {
    if (reasoning.effort !== undefined) throw new Error("Reasoning effort is not accepted when reasoning is disabled");
    return { model: model.key, reasoning: { enabled: false } };
  }
  if (model.reasoning.efforts.length === 0) {
    if (reasoning.effort !== undefined) throw new Error(`${model.key} does not support reasoning effort`);
    return { model: model.key, reasoning: { enabled: true } };
  }
  if (typeof reasoning.effort !== "string" || !model.reasoning.efforts.includes(reasoning.effort as ReasoningEffort)) {
    throw new Error(`${model.key} requires a supported reasoning effort`);
  }
  return { model: model.key, reasoning: { enabled: true, effort: reasoning.effort as ReasoningEffort } };
}

export function modelByKey(key: string): ModelCatalogEntry {
  const model = MODEL_CATALOG.find((candidate) => candidate.key === key);
  if (!model) throw new Error(`Unsupported model selection: ${key}`);
  return model;
}
