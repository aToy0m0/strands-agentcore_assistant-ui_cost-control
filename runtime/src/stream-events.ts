import type { AgentStreamEvent } from "@strands-agents/sdk";
import type { AgentOutputEvent } from "./app.js";
import { modelByKey, type InferenceSelection } from "../../shared/model-catalog.js";
import { ReasoningTagSplitter } from "./reasoning-tags.js";

export async function* toSafeAgentOutput(
  events: AsyncIterable<AgentStreamEvent>,
  selection: InferenceSelection,
): AsyncIterable<AgentOutputEvent> {
  const visibility = modelByKey(selection.model).reasoning.contentVisibility;
  let emittedRedactedReasoning = false;
  let emittedAnswerProgress = false;
  let reasoningBlockOpen = false;
  const splitter = new ReasoningTagSplitter();

  for await (const event of events) {
    if (event.type === "interruptEvent") {
      const reason = event.interrupt.reason;
      const details = typeof reason === "object" && reason !== null && !Array.isArray(reason)
        ? reason as Record<string, unknown>
        : {};
      const question = typeof details.question === "string" ? details.question : "入力が必要です。";
      yield {
        type: "interrupt",
        interrupts: [{
          id: event.interrupt.id,
          reason: "input_required",
          message: question,
          metadata: details,
        }],
      };
      continue;
    }
    if (event.type === "beforeToolCallEvent") {
      if (reasoningBlockOpen) {
        reasoningBlockOpen = false;
        yield { type: "reasoning-end" };
      }
      yield { type: "tool-start", id: event.toolUse.toolUseId, name: event.toolUse.name, input: event.toolUse.input };
      continue;
    }
    if (event.type === "afterToolCallEvent") {
      yield {
        type: "tool-result",
        id: event.toolUse.toolUseId,
        result: event.result.toJSON().toolResult.content,
        ...(event.error ? { error: event.error.message } : {}),
      };
      continue;
    }
    if (event.type !== "modelStreamUpdateEvent") continue;

    const modelEvent = event.event;
    if (modelEvent.type === "modelContentBlockStopEvent") {
      if (reasoningBlockOpen) {
        reasoningBlockOpen = false;
        yield { type: "reasoning-end" };
      }
      continue;
    }
    if (modelEvent.type !== "modelContentBlockDeltaEvent") continue;
    if (modelEvent.delta.type === "reasoningContentDelta") {
      reasoningBlockOpen = true;
      if (visibility === "redacted") {
        if (!emittedRedactedReasoning) {
          emittedRedactedReasoning = true;
          yield { type: "reasoning", text: "内容を考えています。\n" };
        }
      } else if (modelEvent.delta.text) {
        yield { type: "reasoning", text: modelEvent.delta.text };
      }
      continue;
    }
    if (modelEvent.delta.type !== "textDelta" || !modelEvent.delta.text) continue;
    for (const segment of splitter.push(modelEvent.delta.text)) {
      if (segment.channel === "reasoning") {
        reasoningBlockOpen = true;
        if (visibility !== "redacted") yield { type: "reasoning", text: segment.text };
        else if (!emittedRedactedReasoning) {
          emittedRedactedReasoning = true;
          yield { type: "reasoning", text: "内容を考えています。\n" };
        }
        continue;
      }
      if (reasoningBlockOpen) {
        reasoningBlockOpen = false;
        yield { type: "reasoning-end" };
      }
      if (!emittedAnswerProgress) {
        emittedAnswerProgress = true;
        yield { type: "reasoning", text: "回答を作成しています。\n" };
      }
      yield { type: "text", text: segment.text };
    }
  }
  for (const segment of splitter.flush()) {
    if (segment.channel === "reasoning") {
      if (visibility !== "redacted") yield { type: "reasoning", text: segment.text };
      continue;
    }
    yield { type: "text", text: segment.text };
  }
  if (reasoningBlockOpen) yield { type: "reasoning-end" };
}
