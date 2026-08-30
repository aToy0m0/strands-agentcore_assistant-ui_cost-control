const MAX_STRING_LENGTH = 50_000;
const REDACTED_KEY = /authorization|token|secret|password/iu;
const DATA_URL = /^data:[^;,]+;base64,/iu;

let enabled = false;

export function setDebugEnabled(value: boolean): void {
  enabled = value;
}

export function isDebugEnabled(): boolean {
  return enabled;
}

export function debugValue(value: unknown, key = "", depth = 0): unknown {
  if (REDACTED_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (DATA_URL.test(value)) return `[BASE64 DATA URL: ${value.length} characters]`;
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}… [truncated ${value.length - MAX_STRING_LENGTH} characters]`
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[MAX DEPTH]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => debugValue(item, key, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([childKey, childValue]) => [childKey, debugValue(childValue, childKey, depth + 1)]));
}

function debugText(value: unknown): string {
  return JSON.stringify(debugValue(value), (_key, child) => typeof child === "bigint" ? `${child}n` : child, 2);
}

export function debugLog(event: string, data?: unknown): void {
  if (!enabled) return;
  console.debug(data === undefined ? `[Workmate debug] ${event}` : `[Workmate debug] ${event}\n${debugText(data)}`);
}

export function debugError(event: string, cause: unknown): void {
  if (!enabled) return;
  console.error(`[Workmate debug] ${event}\n${debugText(cause)}`);
}

export function parsedRequestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return body == null ? undefined : `[${body.constructor.name}]`;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

export function installBrowserDebugHandlers(): () => void {
  if (!enabled) return () => undefined;
  const error = (event: ErrorEvent) => debugError("window.error", event.error ?? event.message);
  const rejection = (event: PromiseRejectionEvent) => debugError("window.unhandledrejection", event.reason);
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  console.info("[Workmate debug] enabled");
  return () => {
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
  };
}
