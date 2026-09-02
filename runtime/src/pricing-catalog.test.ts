import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoModelPricingCatalog, ModelPricingUnavailableError } from "./pricing-catalog.js";

function catalog(item: ReturnType<typeof priceItem> | undefined) {
  const send = vi.fn(async (command: unknown) => {
    expect(command).toBeInstanceOf(GetItemCommand);
    expect((command as GetItemCommand).input.ConsistentRead).toBe(true);
    return item ? { Item: item } : {};
  });
  return {
    value: new DynamoModelPricingCatalog({ send } as unknown as DynamoDBClient, {
      tableName: "ModelPricingCatalog",
      sourceRegion: "us-east-1",
      serviceTier: "standard",
    }),
    send,
  };
}

describe("DynamoModelPricingCatalog", () => {
  it("強整合読み取りした有効な価格スナップショットを返す", async () => {
    const { value, send } = catalog(priceItem());
    await expect(value.requiredSnapshot("model-1", "geo-us", new Date("2026-09-01T00:00:00Z"))).resolves.toEqual({
      modelId: "model-1",
      version: "v1",
      verifiedAt: "2026-08-30T00:00:00Z",
      verifiedUntil: "2026-09-30T23:59:59Z",
      inputPerMillionTokens: 1_100_000_000n,
      outputPerMillionTokens: 5_500_000_000n,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("確認期限切れならモデルを呼び出せない", async () => {
    const { value } = catalog(priceItem());
    await expect(value.requiredSnapshot("model-1", "geo-us", new Date("2026-10-01T00:00:00Z")))
      .rejects.toThrow("確認期限外");
  });

  it.each([
    ["status", { S: "SUSPENDED" }],
    ["sourceRegion", { S: "us-west-2" }],
    ["routing", { S: "global" }],
    ["serviceTier", { S: "priority" }],
  ])("%sが期待条件と異なる場合は停止する", async (name, value) => {
    const item = priceItem();
    item[name] = value;
    const { value: catalogValue } = catalog(item);
    await expect(catalogValue.requiredSnapshot("model-1", "geo-us", new Date("2026-09-01T00:00:00Z")))
      .rejects.toBeInstanceOf(ModelPricingUnavailableError);
  });

  it("価格未登録なら停止する", async () => {
    const { value } = catalog(undefined);
    await expect(value.requiredSnapshot("model-1", "geo-us", new Date("2026-09-01T00:00:00Z")))
      .rejects.toThrow("登録されていない");
  });
});

function priceItem() {
  return {
    modelId: { S: "model-1" },
    status: { S: "ACTIVE" },
    currency: { S: "USD" },
    sourceRegion: { S: "us-east-1" },
    routing: { S: "geo-us" },
    serviceTier: { S: "standard" },
    inputNanoUsdPerMillionTokens: { N: "1100000000" },
    outputNanoUsdPerMillionTokens: { N: "5500000000" },
    verifiedAt: { S: "2026-08-30T00:00:00Z" },
    verifiedUntil: { S: "2026-09-30T23:59:59Z" },
    version: { S: "v1" },
  };
}
