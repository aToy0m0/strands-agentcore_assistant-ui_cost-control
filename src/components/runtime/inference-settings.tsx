"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAui, type LanguageModelConfig } from "@assistant-ui/react";
import type { InferenceSelection, ReasoningEffort, RuntimeModelOption, RuntimeOptions } from "@/lib/runtime-options";

type InferenceSettingsValue = {
  options: RuntimeOptions;
  selection: InferenceSelection;
  selectedModel: RuntimeModelOption;
  selectModel: (model: string) => void;
  setReasoningEnabled: (enabled: boolean) => void;
  setEffort: (effort: ReasoningEffort) => void;
};

const InferenceSettingsContext = createContext<InferenceSettingsValue | null>(null);

function modelFrom(options: RuntimeOptions, id: string): RuntimeModelOption {
  const model = options.models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`選択可能なモデルではありません: ${id}`);
  return model;
}

function enabledSelection(model: RuntimeModelOption, preferredEffort: ReasoningEffort = "medium"): InferenceSelection["reasoning"] {
  if (model.reasoning.efforts.length === 0) return { enabled: true };
  const effort = model.reasoning.efforts.includes(preferredEffort) ? preferredEffort : model.reasoning.efforts[0];
  if (!effort) throw new Error(`${model.label}のReasoning設定が不正です`);
  return { enabled: true, effort };
}

export function InferenceSettingsProvider({ options, children }: { options: RuntimeOptions; children: ReactNode }) {
  const api = useAui();
  const initialModel = modelFrom(options, options.defaultSelection.model);
  const [selection, setSelection] = useState<InferenceSelection>({
    model: initialModel.id,
    reasoning: enabledSelection(initialModel, options.defaultSelection.reasoning.effort),
  });
  const selectedModel = modelFrom(options, selection.model);

  useEffect(() => api.modelContext.register({
    getModelContext: () => ({
      config: { inference: selection } as unknown as LanguageModelConfig,
    }),
  }), [api, selection]);

  const value = useMemo<InferenceSettingsValue>(() => ({
    options,
    selection,
    selectedModel,
    selectModel: (modelId) => {
      const nextModel = modelFrom(options, modelId);
      if (!selection.reasoning.enabled) {
        setSelection({ model: nextModel.id, reasoning: { enabled: false } });
        return;
      }
      const preferred = selection.reasoning.enabled ? selection.reasoning.effort : "medium";
      setSelection({ model: nextModel.id, reasoning: enabledSelection(nextModel, preferred) });
    },
    setReasoningEnabled: (enabled) => {
      if (!enabled) {
        setSelection({ model: selectedModel.id, reasoning: { enabled: false } });
        return;
      }
      setSelection({ model: selectedModel.id, reasoning: enabledSelection(selectedModel) });
    },
    setEffort: (effort) => {
      if (!selectedModel.reasoning.efforts.includes(effort)) throw new Error(`${selectedModel.label}では${effort}を選択できません`);
      setSelection({ model: selectedModel.id, reasoning: { enabled: true, effort } });
    },
  }), [options, selectedModel, selection]);

  return <InferenceSettingsContext.Provider value={value}>{children}</InferenceSettingsContext.Provider>;
}

export function useInferenceSettings(): InferenceSettingsValue {
  const value = useContext(InferenceSettingsContext);
  if (!value) throw new Error("useInferenceSettings must be used inside InferenceSettingsProvider");
  return value;
}
