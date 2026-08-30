import { tool, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";

const MAX_TEXT_UTF16_CODE_UNITS = 100_000;
const finiteNumber = z.number().finite();

export type CalculatorInput = {
  operation: "add" | "subtract" | "multiply" | "divide";
  a: number;
  b: number;
};

export function calculate({ operation, a, b }: CalculatorInput) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Calculator operands must be finite numbers");
  if (operation === "divide" && b === 0) throw new Error("Division by zero is not allowed");
  const result = operation === "add"
    ? a + b
    : operation === "subtract"
      ? a - b
      : operation === "multiply"
        ? a * b
        : a / b;
  if (!Number.isFinite(result)) throw new Error("Calculator result must be a finite number");
  return result;
}

export const calculator = tool({
  name: "calculator",
  description: "Use only when exact addition, subtraction, multiplication, or division is required.",
  inputSchema: z.object({
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    a: finiteNumber,
    b: finiteNumber,
  }),
  callback: calculate,
});

function assertTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch (error) {
    throw new Error(`Invalid IANA timezone: ${timezone}`, { cause: error });
  }
}

function dateParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function currentDateTimeAt(date: Date, timezone: string) {
  if (!Number.isFinite(date.getTime())) throw new Error("Current datetime source must be valid");
  assertTimeZone(timezone);
  const parts = dateParts(date, timezone);
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName?.replace(/^GMT/u, "");
  if (!parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute || !parts.second || !offset) {
    throw new Error("Datetime formatter returned incomplete fields");
  }
  return {
    timezone,
    isoUtc: date.toISOString(),
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    localDateTime: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`,
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(date),
    unixMilliseconds: date.getTime(),
  };
}

export const currentDatetime = tool({
  name: "current_datetime",
  description: "Use for the current date or time and timezone conversion. The timezone must be an IANA name.",
  inputSchema: z.object({ timezone: z.string().min(1) }),
  callback: ({ timezone }) => currentDateTimeAt(new Date(), timezone),
});

function assertLocale(locale: string) {
  try {
    if (Intl.getCanonicalLocales(locale).length !== 1) throw new Error("Locale must identify exactly one locale");
    new Intl.Segmenter(locale).segment("");
  } catch (error) {
    throw new Error(`Invalid locale: ${locale}`, { cause: error });
  }
}

export function textStatistics(text: string, locale = "ja-JP") {
  if (text.length > MAX_TEXT_UTF16_CODE_UNITS) {
    throw new Error(`Text exceeds ${MAX_TEXT_UTF16_CODE_UNITS} UTF-16 code units`);
  }
  assertLocale(locale);
  const graphemes = [...new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(text)];
  const words = [...new Intl.Segmenter(locale, { granularity: "word" }).segment(text)]
    .filter((segment) => segment.isWordLike).length;
  return {
    characters: graphemes.length,
    codePoints: [...text].length,
    utf16CodeUnits: text.length,
    utf8Bytes: Buffer.byteLength(text, "utf8"),
    words,
    lines: text.length === 0 ? 0 : text.split(/\r\n|\n|\r/u).length,
    nonWhitespaceCharacters: graphemes.filter(({ segment }) => segment.trim().length > 0).length,
  };
}

export const textStatisticsTool = tool({
  name: "text_statistics",
  description: "Use only to count graphemes, code points, UTF-16 units, UTF-8 bytes, words, lines, or non-whitespace characters.",
  inputSchema: z.object({
    text: z.string().max(MAX_TEXT_UTF16_CODE_UNITS),
    locale: z.string().min(1).optional(),
  }),
  callback: ({ text, locale }) => textStatistics(text, locale),
});

export type AskUserInput = {
  question: string;
  options?: string[];
  allowFreeText?: boolean;
};

export function askUser(input: AskUserInput, context?: ToolContext) {
  if (!context) throw new Error("ask_user requires an agent tool context");
  const answer = context.interrupt<string>({
    name: "ask-user",
    reason: {
      question: input.question,
      ...(input.options ? { options: input.options } : {}),
      allowFreeText: input.allowFreeText ?? true,
    },
  });
  if (typeof answer !== "string" || !answer.trim()) throw new Error("ask_user requires a non-empty user answer");
  return { answer: answer.trim() };
}

export const askUserTool = tool({
  name: "ask_user",
  description: "Pause and ask the user one necessary clarifying question. Use only when missing information materially changes the result. Provide concise options when the choices are known.",
  inputSchema: z.object({
    question: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(100)).min(2).max(6).optional(),
    allowFreeText: z.boolean().optional(),
  }),
  callback: askUser,
});

export const utilityTools = [calculator, currentDatetime, textStatisticsTool, askUserTool];
