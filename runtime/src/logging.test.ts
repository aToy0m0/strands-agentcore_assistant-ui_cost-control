import { describe, expect, it } from "vitest";
import { createRuntimeLogger, parseLogSettings } from "./logging.js";

describe("parseLogSettings", () => {
  it("未設定ならすべて有効", () => {
    expect(parseLogSettings({})).toEqual({ request: true, model: true, tool: true });
  });

  it("offを指定した種別だけ無効にする", () => {
    expect(parseLogSettings({ RUNTIME_LOG_MODEL: "off" })).toEqual({ request: true, model: false, tool: true });
  });

  it("false/0/noと大文字小文字の揺れも無効として扱う", () => {
    for (const value of ["false", "0", "no", "OFF", " False "]) {
      expect(parseLogSettings({ RUNTIME_LOG_TOOL: value }).tool).toBe(false);
    }
  });

  it("空文字や想定外の値は有効のままにする", () => {
    expect(parseLogSettings({ RUNTIME_LOG_REQUEST: "" }).request).toBe(true);
    expect(parseLogSettings({ RUNTIME_LOG_REQUEST: "on" }).request).toBe(true);
  });
});

describe("createRuntimeLogger", () => {
  function collect() {
    const lines: string[] = [];
    const errors: string[] = [];
    const logger = createRuntimeLogger(parseLogSettings({ RUNTIME_LOG_MODEL: "off" }), (line) => lines.push(line), (line) => errors.push(line));
    return { logger, lines, errors };
  }

  it("有効な種別は1行のJSONで出す", () => {
    const { logger, lines } = collect();
    logger.log("request", "invocation.received", { threadId: "t1", prompt: "こんにちは" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ event: "invocation.received", category: "request", threadId: "t1", prompt: "こんにちは" });
  });

  it("無効な種別は何も出さない", () => {
    const { logger, lines } = collect();
    logger.log("model", "assistant.completed", { text: "応答" });
    expect(lines).toHaveLength(0);
  });

  it("errorは無効化の対象外で常に出す", () => {
    const { logger, errors } = collect();
    logger.error("invocation.failed", { message: "失敗" });
    expect(JSON.parse(errors[0] ?? "")).toEqual({ event: "invocation.failed", category: "error", message: "失敗" });
  });

  it("直列化できない値でもログのために処理を壊さない", () => {
    const { logger, lines } = collect();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.log("request", "invocation.received", { circular })).not.toThrow();
    expect(JSON.parse(lines[0] ?? "")).toEqual({ event: "invocation.received", serializationFailed: true });
  });
});
