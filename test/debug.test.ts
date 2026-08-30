import { afterEach, describe, expect, it, vi } from "vitest";
import { debugLog, debugValue, parsedRequestBody, setDebugEnabled } from "../src/lib/debug.js";

afterEach(() => {
  setDebugEnabled(false);
  vi.restoreAllMocks();
});

describe("browser debug", () => {
  it("無効時はConsoleへ出力しない", () => {
    const output = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    debugLog("test", { value: 1 });
    expect(output).not.toHaveBeenCalled();
  });

  it("有効時は機密キーとBase64添付をマスクする", () => {
    const output = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    setDebugEnabled(true);
    debugLog("test", {
      authorization: "Bearer secret",
      nested: { accessToken: "token-value" },
      image: "data:image/png;base64,AAAA",
    });
    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]?.[0]).toBe(`[Workmate debug] test
{
  "authorization": "[REDACTED]",
  "nested": {
    "accessToken": "[REDACTED]"
  },
  "image": "[BASE64 DATA URL: 26 characters]"
}`);
  });

  it("JSONリクエスト本文を確認可能な値へ変換する", () => {
    expect(parsedRequestBody('{"operation":"memory.listThreads"}')).toEqual({ operation: "memory.listThreads" });
    expect(parsedRequestBody("not-json")).toBe("not-json");
    expect(debugValue({ password: "hidden" })).toEqual({ password: "[REDACTED]" });
  });
});
