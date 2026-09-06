import { GetItemCommand, PutItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, DynamoBudgetLedger } from "./budget-ledger.js";

function ledger(send: (command: unknown) => Promise<unknown>) {
  return new DynamoBudgetLedger({ send } as never, { tableName: "budget", budgetScopeId: "sample-app" });
}

describe("DynamoBudgetLedger", () => {
  it("確定実績と入力見積りが月額上限以下なら開始を許可する", async () => {
    let reads = 0;
    const value = ledger(async (command) => {
      expect(command).toBeInstanceOf(GetItemCommand);
      reads += 1;
      return reads === 1 ? { Item: { limitNanoUsd: { N: "100" } } } : { Item: { spentNanoUsd: { N: "70" }, uncertainCount: { N: "0" } } };
    });
    await expect(value.assertCanStart("2026-09", 30n)).resolves.toBeUndefined();
  });

  it("月額超過では開始せず、旧uncertainCountは判定に使わない", async () => {
    const over = ledger(async (command) => command instanceof GetItemCommand && command.input.Key?.SK?.S === "CONFIG"
      ? { Item: { limitNanoUsd: { N: "100" } } }
      : { Item: { spentNanoUsd: { N: "71" }, uncertainCount: { N: "0" } } });
    await expect(over.assertCanStart("2026-09", 30n)).rejects.toBeInstanceOf(BudgetExceededError);

    const uncertain = ledger(async (command) => command instanceof GetItemCommand && command.input.Key?.SK?.S === "CONFIG"
      ? { Item: { limitNanoUsd: { N: "100" } } }
      : { Item: { spentNanoUsd: { N: "10" }, uncertainCount: { N: "1" } } });
    await expect(uncertain.assertCanStart("2026-09", 1n)).resolves.toBeUndefined();
  });

  it("usageEventId作成と月次加算を同じtransactionで行う", async () => {
    let captured: TransactWriteItemsCommand | undefined;
    const send = vi.fn(async (command: unknown) => { captured = command as TransactWriteItemsCommand; return {}; });
    const value = ledger(send);
    await value.recordUsage({
      usageEventId: "usage-1", month: "2026-09", modelId: "model-1",
      inputTokens: 10, outputTokens: 5, costNanoUsd: 30n, occurredAt: new Date("2026-09-05T00:00:00Z"),
    });
    const command = captured!;
    expect(command).toBeInstanceOf(TransactWriteItemsCommand);
    expect(command.input.TransactItems).toHaveLength(2);
    expect(command.input.TransactItems?.[0]?.Put?.ConditionExpression).toContain("attribute_not_exists");
    expect(command.input.TransactItems?.[1]?.Update?.UpdateExpression).toContain("spentNanoUsd");
  });

  it.each(["NO_CHARGE", "USAGE_UNAVAILABLE"] as const)("%sを月次金額へ加算せず冪等に記録する", async (status) => {
    let captured: PutItemCommand | undefined;
    const send = vi.fn(async (command: unknown) => { captured = command as PutItemCommand; return {}; });
    await ledger(send).recordUnpricedUsage({
      usageEventId: "usage-2", month: "2026-09", modelId: "model-1", status,
      occurredAt: new Date("2026-09-05T00:00:00Z"),
    });
    const command = captured!;
    expect(command).toBeInstanceOf(PutItemCommand);
    expect(command.input.Item?.status?.S).toBe(status);
    expect(command.input.Item?.costNanoUsd).toBeUndefined();
  });
});
