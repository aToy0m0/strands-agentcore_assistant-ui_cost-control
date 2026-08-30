import { debugLog } from "./debug.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function runErrorMessageFromSse(body: string): string | undefined {
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim()) as unknown;
      if (isRecord(event) && event.type === "RUN_ERROR" && typeof event.message === "string") return event.message;
    } catch {
      throw new Error("履歴APIから不正なSSEイベントを受信しました");
    }
  }
  return undefined;
}

export async function readMemoryResponse(response: Response): Promise<unknown> {
  if (response.status === 204) {
    debugLog("history.response", { status: response.status });
    return undefined;
  }

  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    const body = await response.text();
    const message = runErrorMessageFromSse(body) ?? "履歴APIが予期しないSSE応答を返しました";
    debugLog("history.response.error", { status: response.status, contentType, message });
    throw new Error(message);
  }
  if (!contentType.includes("application/json")) {
    throw new Error(`履歴APIのContent-Typeが不正です: ${contentType || "未指定"}`);
  }

  const payload = await response.json() as unknown;
  if (!response.ok) {
    debugLog("history.response.error", { status: response.status, payload });
    const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  debugLog("history.response", { status: response.status, payload });
  return payload;
}
