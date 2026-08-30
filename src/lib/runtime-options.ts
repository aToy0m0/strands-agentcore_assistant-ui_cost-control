export type ReasoningEffort = "low" | "medium" | "high";

export type RuntimeModelOption = {
  id: string;
  label: string;
  provider: "amazon" | "anthropic" | "openai" | "zai";
  pricing: {
    currency: "USD";
    region: "us-east-1";
    tier: "standard";
    inputPerMillionTokens: number;
    outputPerMillionTokens: number;
    verifiedAt: string;
    effectiveUntil?: string;
  } | null;
  reasoning: {
    control: "optional" | "always-on";
    efforts: readonly ReasoningEffort[];
    contentVisibility: "redacted" | "summary" | "full";
  };
};

export type RuntimeOptions = {
  defaultSelection: {
    model: string;
    reasoning: { enabled: true; effort: "medium" };
  };
  verifiedAt: string;
  pricingBasis: string;
  models: RuntimeModelOption[];
};

export type InferenceSelection = {
  model: string;
  reasoning: { enabled: false } | { enabled: true; effort?: ReasoningEffort };
};
