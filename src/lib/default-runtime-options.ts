import { COST_CONTROLLED_MODEL_CATALOG, DEFAULT_INFERENCE_SELECTION } from "../../shared/model-catalog";
import type { RuntimeOptions } from "./runtime-options";

export const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = {
  defaultSelection: {
    model: DEFAULT_INFERENCE_SELECTION.model,
    reasoning: { enabled: true, effort: "medium" },
  },
  models: COST_CONTROLLED_MODEL_CATALOG.map((model) => ({
    id: model.key,
    label: model.label,
    provider: model.provider,
    costControl: model.tokenCounter.kind === "usage-only" ? "soft" : "hard",
    reasoning: model.reasoning,
  })),
};
