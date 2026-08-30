import { describe, expect, it } from "vitest";
import type { RunAgentInput } from "@ag-ui/core";
import { historyFrom } from "./history.js";

function input(messages: RunAgentInput["messages"]): RunAgentInput {
  return { threadId: "thread", runId: "run", state: {}, messages, tools: [], context: [], forwardedProps: {} };
}

describe("historyFrom", () => {
  it("seeds all completed turns and excludes the latest user prompt", () => {
    expect(historyFrom(input([
      { id: "u1", role: "user", content: "最初の質問" },
      { id: "a1", role: "assistant", content: "最初の回答" },
      { id: "u2", role: "user", content: "続きの質問" },
    ]))).toEqual([
      { role: "user", content: [{ text: "最初の質問" }] },
      { role: "assistant", content: [{ text: "最初の回答" }] },
    ]);
  });

  it("drops display-only roles from the model history", () => {
    expect(historyFrom(input([
      { id: "system", role: "system", content: "system" },
      { id: "reasoning", role: "reasoning", content: "安全な進捗要約" },
      { id: "u1", role: "user", content: "質問" },
    ]))).toEqual([]);
  });
});
