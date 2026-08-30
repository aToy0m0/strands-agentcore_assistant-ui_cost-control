import { describe, expect, it } from "vitest";
import { toAnthropicCountTokensRequest } from "./token-counter.js";

describe("Anthropic Mantle CountTokens request", () => {
  it("Converseのsystem・messages・tools・thinkingを同じ意味のMessages形式へ変換する", () => {
    expect(toAnthropicCountTokensRequest({
      system: [{ text: "system" }],
      messages: [
        { role: "user", content: [{ text: "hello" }] },
        { role: "assistant", content: [{ toolUse: { toolUseId: "tool-1", name: "lookup", input: { id: 1 } } }] },
        { role: "user", content: [{ toolResult: { toolUseId: "tool-1", status: "success", content: [{ json: { ok: true } }] } }] },
      ],
      toolConfig: {
        tools: [{ toolSpec: { name: "lookup", description: "Lookup", inputSchema: { json: { type: "object" } } } }],
        toolChoice: { auto: {} },
      },
      additionalModelRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: "medium" } },
    }, "anthropic.claude-sonnet-5")).toEqual({
      model: "anthropic.claude-sonnet-5",
      system: [{ type: "text", text: "system" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "lookup", input: { id: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "{\"ok\":true}" }] }] },
      ],
      tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
  });

  it("意味を維持できないContentBlockは過小計数せず拒否する", () => {
    expect(() => toAnthropicCountTokensRequest({
      messages: [{ role: "user", content: [{ video: { format: "mp4", source: { bytes: new Uint8Array([1]) } } }] }],
    }, "anthropic.claude-sonnet-5")).toThrow("cannot be represented");
  });
});
