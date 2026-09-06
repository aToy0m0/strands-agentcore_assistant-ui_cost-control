import { describe, expect, it, vi } from "vitest";
import { countTokensWithSource } from "./token-count-logging.js";

describe("countTokensWithSource", () => {
  it("SDK概算への切替を構造化ログへ残す", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(countTokensWithSource("model-1", "bedrock", async () => 12)).resolves.toEqual({
      inputTokens: 12,
      source: "provider-sdk-estimate",
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"event":"model.token_count.fallback"'));
    warning.mockRestore();
  });
});
