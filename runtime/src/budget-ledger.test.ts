import { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, DynamoBudgetLedger } from "./budget-ledger.js";

function ledger(send: ReturnType<typeof vi.fn>) {
  return new DynamoBudgetLedger({ send } as unknown as DynamoDBClient, {
    tableName: "BudgetLedger", accountId: "123456789012", projectId: "cost-control",
    accountLimitNanoUsd: 100_000_000_000n, projectLimitNanoUsd: 60_000_000_000n,
  });
}

describe("DynamoBudgetLedger", () => {
  it("アカウント・プロジェクト・requestを1 transactionで予約する", async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    await ledger(send).reserve({ requestId: "request-1", month: "2026-08", modelId: "model-1", maximumNanoUsd: 2_000_000n, user: userLimit() });
    const command = send.mock.calls[0]![0] as TransactWriteItemsCommand;
    expect(command).toBeInstanceOf(TransactWriteItemsCommand);
    expect(command.input.TransactItems).toHaveLength(4);
    expect(command.input.TransactItems?.[0]?.Update?.Key).toEqual({ PK: { S: "MONTH#2026-08" }, SK: { S: "ACCOUNT#123456789012" } });
    expect(command.input.TransactItems?.[1]?.Update?.Key).toEqual({ PK: { S: "MONTH#2026-08" }, SK: { S: "PROJECT#cost-control" } });
    expect(command.input.TransactItems?.[2]?.Update?.Key).toEqual({ PK: { S: "USER_WINDOW#daily#2026-08-30" }, SK: { S: "USER#user-1" } });
  });

  it("条件付きtransaction失敗時は上限超過として停止する", async () => {
    const cancellation = Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof TransactWriteItemsCommand) throw cancellation;
      if (command instanceof GetItemCommand) return {};
      throw new Error("unexpected command");
    });
    await expect(ledger(send).reserve({ requestId: "request-2", month: "2026-08", modelId: "model-1", maximumNanoUsd: 2_000_000n, user: userLimit() }))
      .rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("実トークン数でユーザー予約を精算する", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetItemCommand) return { Item: reservationItem() };
      if (command instanceof TransactWriteItemsCommand) return {};
      throw new Error("unexpected command");
    });
    await ledger(send).settle("request-3", 1_000_000n, 2_000);
    const command = send.mock.calls[1]![0] as TransactWriteItemsCommand;
    expect(command.input.TransactItems).toHaveLength(4);
    expect(command.input.TransactItems?.[2]?.Update?.Key).toEqual({ PK: { S: "USER_WINDOW#daily#2026-08-30" }, SK: { S: "USER#user-1" } });
    expect(command.input.TransactItems?.[2]?.Update?.ExpressionAttributeValues?.[":actual"]).toEqual({ N: "2000" });
  });
});

function userLimit() {
  return { actorId: "user-1", profileId: "daily", window: "daily#2026-08-30", tokenLimit: 50_000, maximumTokens: 16_250 };
}

function reservationItem() {
  return {
    PK: { S: "REQUEST#request-3" }, SK: { S: "RESERVATION" }, requestId: { S: "request-3" }, month: { S: "2026-08" },
    accountId: { S: "123456789012" }, projectId: { S: "cost-control" }, modelId: { S: "model-1" }, reservedNanoUsd: { N: "2000000" },
    actorId: { S: "user-1" }, userProfileId: { S: "daily" }, userWindow: { S: "daily#2026-08-30" }, reservedTokens: { N: "16250" }, status: { S: "RESERVED" },
  };
}
