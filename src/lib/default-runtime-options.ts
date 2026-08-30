import { COST_CONTROLLED_MODEL_CATALOG, DEFAULT_INFERENCE_SELECTION } from "../../shared/model-catalog";
import type { RuntimeOptions } from "./runtime-options";

export const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = {
  defaultSelection: {
    model: DEFAULT_INFERENCE_SELECTION.model,
    reasoning: { enabled: true, effort: "medium" },
  },
  verifiedAt: "2026-08-30T00:00:00.000Z",
  pricingBasis: "us-east-1のGeo Cross-Regionオンデマンド標準料金（2026-08-30確認）",
  models: COST_CONTROLLED_MODEL_CATALOG.map((model) => ({
    id: model.key,
    label: model.label,
    provider: model.provider,
    pricing: model.pricing,
    reasoning: model.reasoning,
  })),
};
