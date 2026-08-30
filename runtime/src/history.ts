import type { MessageData } from "@strands-agents/sdk";
import type { Message, RunAgentInput } from "@ag-ui/core";

function textFromMessage(message: Message): string {
  if (!("content" in message) || message.content == null) throw new Error("History messages must contain text");
  if (typeof message.content === "string") return message.content;
  return (message.content as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === "text")
    .flatMap((part) => typeof part.text === "string" ? [part.text] : [])
    .join("\n")
    .trim();
}

export function historyFrom(input: RunAgentInput): MessageData[] {
  let latestUserIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) throw new Error("A user message is required");
  return input.messages.slice(0, latestUserIndex).flatMap((message) => {
    // Reasoningなどの表示専用メッセージはモデルの会話履歴へ渡さない。
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textFromMessage(message);
    if (!text) throw new Error("History messages must contain text");
    return [{ role: message.role, content: [{ text }] }];
  });
}
