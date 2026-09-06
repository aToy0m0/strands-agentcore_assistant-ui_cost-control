import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

function runAws(arguments_) {
  const result = spawnSync("aws", arguments_, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout.trim();
}

function stackOutput(outputKey, region, profile) {
  const value = runAws([
    "cloudformation", "describe-stacks", "--stack-name", "agent-core-runtime-cost-control-stack",
    "--query", `Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue | [0]`, "--output", "text",
    "--region", region, "--profile", profile,
  ]);
  if (!value || value === "None") throw new Error(`stack output ${outputKey} was not found`);
  return value;
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function nonNegativeInteger(value, name) {
  const text = required(value, name);
  if (!/^\d+$/u.test(text)) throw new Error(`${name} must be a non-negative integer`);
  return text;
}

function main() {
  const operation = process.argv[2];
  if (operation !== "list-uncertain" && operation !== "resolve-uncertain") {
    throw new Error("operation must be list-uncertain or resolve-uncertain");
  }
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      region: { type: "string", default: "us-east-1" },
      "usage-event-id": { type: "string" },
      "input-tokens": { type: "string" },
      "output-tokens": { type: "string" },
      "cost-nano-usd": { type: "string" },
      "waive-cost": { type: "boolean", default: false },
    },
    strict: true,
  });
  const region = required(values.region, "--region");
  const profile = operation === "list-uncertain" ? "default" : "admin";
  const tableName = stackOutput("BudgetLedgerTableName", region, profile);
  const budgetScopeId = stackOutput("BudgetScopeId", region, profile);
  const common = ["--region", region, "--profile", profile];
  if (operation === "list-uncertain") {
    console.log(runAws([
      "dynamodb", "query", "--table-name", tableName,
      "--key-condition-expression", "PK = :pk AND begins_with(SK, :usage)",
      "--filter-expression", "#status = :uncertain",
      "--expression-attribute-names", JSON.stringify({ "#status": "status" }),
      "--expression-attribute-values", JSON.stringify({ ":pk": { S: `APP#${budgetScopeId}` }, ":usage": { S: "USAGE#" }, ":uncertain": { S: "UNCERTAIN" } }),
      "--consistent-read", "--output", "json", ...common,
    ]));
    return;
  }

  const usageEventId = required(values["usage-event-id"], "--usage-event-id");
  const inputTokens = nonNegativeInteger(values["input-tokens"], "--input-tokens");
  const outputTokens = nonNegativeInteger(values["output-tokens"], "--output-tokens");
  const costNanoUsd = values["waive-cost"]
    ? "0"
    : nonNegativeInteger(values["cost-nano-usd"], "--cost-nano-usd");
  const key = { PK: { S: `APP#${budgetScopeId}` }, SK: { S: `USAGE#${usageEventId}` } };
  const response = JSON.parse(runAws(["dynamodb", "get-item", "--table-name", tableName, "--key", JSON.stringify(key), "--consistent-read", "--output", "json", ...common]));
  const item = response.Item;
  if (!item || item.status?.S !== "UNCERTAIN" || !item.month?.S) throw new Error("usage event is not unresolved");
  const resolvedAt = new Date().toISOString();
  const status = values["waive-cost"] ? "RESOLVED_NO_COST" : "APPLIED";
  const transaction = [
    { Update: {
      TableName: tableName, Key: key,
      UpdateExpression: "SET #status = :status, inputTokens = :inputTokens, outputTokens = :outputTokens, costNanoUsd = :cost, resolvedAt = :resolvedAt",
      ConditionExpression: "#status = :uncertain",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": { S: status }, ":uncertain": { S: "UNCERTAIN" }, ":inputTokens": { N: inputTokens },
        ":outputTokens": { N: outputTokens }, ":cost": { N: costNanoUsd }, ":resolvedAt": { S: resolvedAt },
      },
    } },
    { Update: {
      TableName: tableName, Key: { PK: { S: `APP#${budgetScopeId}` }, SK: { S: `MONTH#${item.month.S}` } },
      UpdateExpression: "SET spentNanoUsd = spentNanoUsd + :cost, uncertainCount = uncertainCount - :one, updatedAt = :resolvedAt",
      ConditionExpression: "uncertainCount >= :one",
      ExpressionAttributeValues: { ":cost": { N: costNanoUsd }, ":one": { N: "1" }, ":resolvedAt": { S: resolvedAt } },
    } },
  ];
  runAws(["dynamodb", "transact-write-items", "--transact-items", JSON.stringify(transaction), ...common]);
  console.log(JSON.stringify({ event: "model.cost.uncertain_resolved", usageEventId, status, inputTokens, outputTokens, costNanoUsd, resolvedAt }));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
