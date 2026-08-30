export type NanoUsd = bigint;

const NANO_USD_PER_USD = 1_000_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
};

export type RateCard = {
  inputPerMillionTokens: NanoUsd;
  outputPerMillionTokens: NanoUsd;
};

function tokenCost(tokens: number, rate: NanoUsd): NanoUsd {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("token count must be a non-negative safe integer");
  return (BigInt(tokens) * rate + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION;
}

export function nanoUsdFromUsd(value: string): NanoUsd {
  if (!/^\d+(\.\d{1,9})?$/.test(value)) throw new Error(`invalid USD amount: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * NANO_USD_PER_USD + BigInt(fraction.padEnd(9, "0"));
}

export function maximumCost(inputTokens: number, maxOutputTokens: number, rate: RateCard): NanoUsd {
  return tokenCost(inputTokens, rate.inputPerMillionTokens) + tokenCost(maxOutputTokens, rate.outputPerMillionTokens);
}

export function actualCost(usage: TokenUsage, rate: RateCard): NanoUsd {
  if ((usage.cacheReadInputTokens ?? 0) !== 0 || (usage.cacheWriteInputTokens ?? 0) !== 0) {
    throw new Error("prompt-cache pricing is not configured");
  }
  return tokenCost(usage.inputTokens, rate.inputPerMillionTokens) + tokenCost(usage.outputTokens, rate.outputPerMillionTokens);
}

export function totalTokens(usage: TokenUsage): number {
  if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) {
    throw new Error("token usage must contain non-negative safe integers");
  }
  const total = usage.inputTokens + usage.outputTokens;
  if (!Number.isSafeInteger(total)) throw new Error("total token usage exceeds the safe integer range");
  return total;
}

export function utcMonth(date = new Date()): string {
  if (Number.isNaN(date.getTime())) throw new Error("invalid date");
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
