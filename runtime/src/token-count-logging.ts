import { AsyncLocalStorage } from "node:async_hooks";
import { configureLogging, type Logger } from "@strands-agents/sdk";

export type TokenCountSource = "provider-api" | "provider-api-with-sdk-estimate" | "provider-sdk-estimate";

type CountState = { modelId: string; provider: "bedrock" | "google"; native: boolean; fallbackReason?: string };
const countState = new AsyncLocalStorage<CountState>();

function message(args: unknown[]): string {
  return args.map((value) => value instanceof Error ? `${value.name}: ${value.message}` : String(value)).join(" ");
}

function observe(args: unknown[]): void {
  const state = countState.getStore();
  if (!state) return;
  const text = message(args);
  if (text.includes("native token count")) state.native = true;
  if (text.includes("falling back") || text.includes("does not support CountTokens")) state.fallbackReason = text;
}

const logger: Logger = {
  debug: (...args) => observe(args),
  info: (...args) => console.info(...args),
  warn: (...args) => { observe(args); console.warn(...args); },
  error: (...args) => console.error(...args),
};

configureLogging(logger);

export async function countTokensWithSource(
  modelId: string,
  provider: "bedrock" | "google",
  count: () => Promise<number>,
): Promise<{ inputTokens: number; source: TokenCountSource }> {
  const state: CountState = { modelId, provider, native: false };
  const inputTokens = await countState.run(state, count);
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new Error("provider token count is invalid");
  const source: TokenCountSource = state.native
    ? provider === "google" ? "provider-api-with-sdk-estimate" : "provider-api"
    : "provider-sdk-estimate";
  if (source === "provider-sdk-estimate") {
    console.warn(JSON.stringify({
      event: "model.token_count.fallback",
      modelId,
      source,
      reason: state.fallbackReason ?? "provider native token count was not used",
    }));
  }
  return { inputTokens, source };
}
