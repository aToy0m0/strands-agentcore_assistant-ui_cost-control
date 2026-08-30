import type { ToolContext } from "@strands-agents/sdk";
import { describe, expect, it, vi } from "vitest";
import { askUser, calculate, calculator, currentDateTimeAt, currentDatetime, textStatistics, textStatisticsTool } from "./tools.js";

describe("ask_user", () => {
  it("interrupts with the question and returns the resumed answer", () => {
    const interrupt = vi.fn(() => "  青  ");
    const result = askUser({ question: "好きな色は？", options: ["赤", "青"] }, { interrupt } as unknown as ToolContext);
    expect(interrupt).toHaveBeenCalledWith({
      name: "ask-user",
      reason: { question: "好きな色は？", options: ["赤", "青"], allowFreeText: true },
    });
    expect(result).toEqual({ answer: "青" });
  });

  it("fails without a tool context instead of fabricating an answer", () => {
    expect(() => askUser({ question: "確認しますか？" })).toThrow("requires an agent tool context");
  });
});

describe("calculator", () => {
  it.each([
    [{ operation: "add" as const, a: 2, b: 3 }, 5],
    [{ operation: "subtract" as const, a: -2, b: 3 }, -5],
    [{ operation: "multiply" as const, a: 1.5, b: 2 }, 3],
    [{ operation: "divide" as const, a: 0, b: 2 }, 0],
  ])("calculates finite arithmetic", (input, expected) => expect(calculate(input)).toBe(expected));

  it("rejects division by zero and non-finite results", () => {
    expect(() => calculate({ operation: "divide", a: 1, b: 0 })).toThrow("Division by zero");
    expect(() => calculate({ operation: "multiply", a: Number.MAX_VALUE, b: 2 })).toThrow("finite");
  });

  it("rejects non-finite input through the tool schema", async () => {
    await expect(calculator.invoke({ operation: "add", a: Number.NaN, b: 1 })).rejects.toThrow();
  });
});

describe("current_datetime", () => {
  const instant = new Date("2026-01-01T15:04:05.006Z");

  it("returns UTC fields from one instant", () => {
    expect(currentDateTimeAt(instant, "UTC")).toEqual({
      timezone: "UTC",
      isoUtc: "2026-01-01T15:04:05.006Z",
      localDate: "2026-01-01",
      localTime: "15:04:05",
      localDateTime: "2026-01-01T15:04:05+00:00",
      weekday: "Thursday",
      unixMilliseconds: instant.getTime(),
    });
  });

  it("handles date rollover and daylight-saving offsets", () => {
    expect(currentDateTimeAt(instant, "Asia/Tokyo").localDateTime).toBe("2026-01-02T00:04:05+09:00");
    expect(currentDateTimeAt(new Date("2026-07-01T12:00:00Z"), "America/New_York").localDateTime)
      .toBe("2026-07-01T08:00:00-04:00");
  });

  it("rejects invalid timezones", async () => {
    expect(() => currentDateTimeAt(instant, "Invalid/Timezone")).toThrow("Invalid IANA timezone");
    await expect(currentDatetime.invoke({ timezone: "Invalid/Timezone" })).rejects.toThrow("Invalid IANA timezone");
  });
});

describe("text_statistics", () => {
  it.each([
    ["", { characters: 0, codePoints: 0, utf16CodeUnits: 0, utf8Bytes: 0, words: 0, lines: 0, nonWhitespaceCharacters: 0 }],
    ["hello world", { characters: 11, codePoints: 11, utf16CodeUnits: 11, utf8Bytes: 11, words: 2, lines: 1, nonWhitespaceCharacters: 10 }],
    ["日本語 test", { characters: 8, codePoints: 8, utf16CodeUnits: 8, utf8Bytes: 14, words: 2, lines: 1, nonWhitespaceCharacters: 7 }],
    ["a\r\nb\rc\n", { characters: 6, codePoints: 7, utf16CodeUnits: 7, utf8Bytes: 7, words: 3, lines: 4, nonWhitespaceCharacters: 3 }],
    ["👨‍👩‍👧‍👦", { characters: 1, codePoints: 7, utf16CodeUnits: 11, utf8Bytes: 25, words: 0, lines: 1, nonWhitespaceCharacters: 1 }],
    ["e\u0301", { characters: 1, codePoints: 2, utf16CodeUnits: 2, utf8Bytes: 3, words: 1, lines: 1, nonWhitespaceCharacters: 1 }],
  ])("returns deterministic statistics", (text, expected) => expect(textStatistics(text)).toEqual(expected));

  it("accepts the maximum length and rejects an overlong string", async () => {
    expect(textStatistics("a".repeat(100_000)).utf16CodeUnits).toBe(100_000);
    expect(() => textStatistics("a".repeat(100_001))).toThrow("exceeds");
    await expect(textStatisticsTool.invoke({ text: "a".repeat(100_001) })).rejects.toThrow();
  });

  it("rejects invalid locales", () => {
    expect(() => textStatistics("text", "not_a_locale")).toThrow("Invalid locale");
  });
});
