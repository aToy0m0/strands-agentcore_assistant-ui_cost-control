import { GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { ModelPricingUnavailableError, S3ModelPricingCatalog } from "./pricing-catalog.js";

function body(value: unknown) {
  return { transformToString: vi.fn(async () => JSON.stringify(value)) };
}

function catalog(model: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    catalogVersion: "v1",
    currency: "USD",
    models: {
      "model-1": {
        sourceRegion: "us-east-1",
        routing: "geo-us",
        serviceTier: "standard",
        verifiedAt: "2026-09-01T00:00:00Z",
        reviewDueAt: "2026-09-30T00:00:00Z",
        inputNanoUsdPerMillionTokens: "100",
        outputNanoUsdPerMillionTokens: "200",
        ...model,
      },
    },
  };
}

function pricing(value: unknown, warningSink = vi.fn()) {
  const send = vi.fn(async (command) => {
    expect(command).toBeInstanceOf(GetObjectCommand);
    return { VersionId: "s3-version", Body: body(value) };
  });
  return { value: new S3ModelPricingCatalog({ send } as never, {
    bucketName: "prices", objectKey: "catalog/model-pricing.json", sourceRegion: "us-east-1", serviceTier: "standard", warningSink,
  }), send, warningSink };
}

describe("S3ModelPricingCatalog", () => {
  it("S3バージョンと承認済み単価を返す", async () => {
    const { value } = pricing(catalog());
    await expect(value.requiredSnapshot("model-1", "geo-us", new Date("2026-09-05T00:00:00Z"))).resolves.toEqual({
      modelId: "model-1", catalogVersion: "v1", catalogS3VersionId: "s3-version",
      verifiedAt: "2026-09-01T00:00:00Z", reviewDueAt: "2026-09-30T00:00:00Z",
      inputPerMillionTokens: 100n, outputPerMillionTokens: 200n,
    });
  });

  it("条件不一致と確認期限切れは警告して継続する", async () => {
    const { value, warningSink } = pricing(catalog({ sourceRegion: "global", reviewDueAt: "2026-09-02T00:00:00Z" }));
    await value.requiredSnapshot("model-1", "geo-us", new Date("2026-09-05T00:00:00Z"));
    expect(warningSink).toHaveBeenCalledWith(expect.objectContaining({ reason: "CONDITION_MISMATCH" }));
    expect(warningSink).toHaveBeenCalledWith(expect.objectContaining({ reason: "REVIEW_OVERDUE" }));
  });

  it("モデル未登録と不正単価は停止する", async () => {
    await expect(pricing(catalog()).value.requiredSnapshot("missing", "geo-us")).rejects.toBeInstanceOf(ModelPricingUnavailableError);
    await expect(pricing(catalog({ inputNanoUsdPerMillionTokens: "0" })).value.requiredSnapshot("model-1", "geo-us"))
      .rejects.toBeInstanceOf(ModelPricingUnavailableError);
  });

  it("入力トークン数に応じてコンテキスト段階単価を選ぶ", async () => {
    const contextPriceTiers = [
      { maxInputTokens: 272_000, inputNanoUsdPerMillionTokens: "220", outputNanoUsdPerMillionTokens: "1320" },
      { maxInputTokens: 1_000_000, inputNanoUsdPerMillionTokens: "440", outputNanoUsdPerMillionTokens: "1980" },
    ];
    const { value } = pricing(catalog({ contextPriceTiers }));
    await expect(value.requiredSnapshot("model-1", "geo-us", new Date("2026-09-05T00:00:00Z"), "us-east-1", 300_000))
      .resolves.toMatchObject({ inputPerMillionTokens: 440n, outputPerMillionTokens: 1980n, contextTierMaxInputTokens: 1_000_000 });
  });

  it("コンテキスト段階単価の上限を超える入力は停止する", async () => {
    const contextPriceTiers = [{ maxInputTokens: 272_000, inputNanoUsdPerMillionTokens: "220", outputNanoUsdPerMillionTokens: "1320" }];
    await expect(pricing(catalog({ contextPriceTiers })).value.requiredSnapshot("model-1", "geo-us", new Date(), "us-east-1", 272_001))
      .rejects.toBeInstanceOf(ModelPricingUnavailableError);
  });
});
