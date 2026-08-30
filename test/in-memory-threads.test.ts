import { describe, expect, it } from "vitest";
import { generatedThreadTitle } from "../src/components/runtime/in-memory-threads.js";

describe("generatedThreadTitle", () => {
  it("uses the normalized first user message", () => {
    const messages = [
      { id: "u1", role: "user", content: [{ type: "text", text: "  最初の\n 質問です  " }] },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "回答" }] },
      { id: "u2", role: "user", content: [{ type: "text", text: "次の質問" }] },
    ];
    expect(generatedThreadTitle(messages)).toBe("最初の 質問です");
  });

  it("limits a title to 60 Unicode code points", () => {
    const messages = [
      { id: "u1", role: "user", content: [{ type: "text", text: "あ".repeat(61) }] },
    ];
    expect(generatedThreadTitle(messages)).toBe("あ".repeat(60));
  });
});
