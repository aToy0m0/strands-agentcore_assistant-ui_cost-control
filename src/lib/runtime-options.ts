export type ReasoningEffort = "low" | "medium" | "high";

export type RuntimeModelOption = {
  id: string;
  label: string;
  provider: "amazon" | "anthropic" | "openai" | "zai";
  costControl: "hard" | "soft";
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
  models: RuntimeModelOption[];
};

export type InferenceSelection = {
  model: string;
  reasoning: { enabled: false } | { enabled: true; effort?: ReasoningEffort };
};
