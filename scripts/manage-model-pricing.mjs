import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

function runAws(arguments_) {
  const result = spawnSync("aws", arguments_, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout.trim();
}

function required(value, option) {
  if (!value?.trim()) throw new Error(`${option}を指定すること`);
  return value.trim();
}

function commonArguments(values) {
  const result = ["--region", values.region];
  if (values.profile) result.push("--profile", values.profile);
  return result;
}

function stackOutput(values, common, outputKey) {
  const value = runAws([
    "cloudformation", "describe-stacks",
    "--stack-name", values.stack,
    "--query", `Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue | [0]`,
    "--output", "text",
    ...common,
  ]);
  if (!value || value === "None") throw new Error(`スタック${values.stack}の${outputKey}出力を取得できない`);
  return value;
}

function main() {
  const operation = process.argv[2];
  if (!new Set(["list", "show", "history", "request", "disable"]).has(operation)) {
    throw new Error("操作はlist、show、history、request、disableのいずれかを指定すること");
  }
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      "model-id": { type: "string" },
      "request-id": { type: "string" },
      "expected-version": { type: "string" },
      profile: { type: "string" },
      region: { type: "string", default: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1" },
      stack: { type: "string", default: "WorkmateCostControlStack" },
    },
    strict: true,
  });
  const common = commonArguments(values);
  const table = stackOutput(values, common, "ModelPricingCatalogTableName");

  if (operation === "list") {
    console.log(runAws([
      "dynamodb", "scan", "--table-name", table,
      "--consistent-read",
      "--projection-expression", "modelId,#s,version,verifiedAt,verifiedUntil,inputNanoUsdPerMillionTokens,outputNanoUsdPerMillionTokens",
      "--expression-attribute-names", '{"#s":"status"}',
      "--query", "Items[].{modelId:modelId.S,status:status.S,version:version.S,verifiedAt:verifiedAt.S,verifiedUntil:verifiedUntil.S,inputNanoUsdPerMillionTokens:inputNanoUsdPerMillionTokens.N,outputNanoUsdPerMillionTokens:outputNanoUsdPerMillionTokens.N}",
      "--output", "table", ...common,
    ]));
    return;
  }

  if (operation === "request") {
    const requestId = required(values["request-id"], "--request-id");
    const ledgerTable = stackOutput(values, common, "BudgetLedgerTableName");
    const reservationKey = JSON.stringify({ PK: { S: `REQUEST#${requestId}` }, SK: { S: "RESERVATION" } });
    const reservationResponse = JSON.parse(runAws([
      "dynamodb", "get-item", "--table-name", ledgerTable, "--key", reservationKey,
      "--consistent-read", "--output", "json", ...common,
    ]));
    const reservation = reservationResponse.Item;
    if (!reservation) throw new Error(`request ID ${requestId}の予約レコードが見つからない`);
    const modelId = reservation.modelId?.S;
    const verificationId = reservation.pricingHistoryKey?.S;
    if (!modelId || !verificationId) throw new Error(`request ID ${requestId}に価格履歴キーが記録されていない`);
    const historyTable = stackOutput(values, common, "ModelPricingHistoryTableName");
    const historyKey = JSON.stringify({ modelId: { S: modelId }, verificationId: { S: verificationId } });
    const historyResponse = JSON.parse(runAws([
      "dynamodb", "get-item", "--table-name", historyTable, "--key", historyKey,
      "--consistent-read", "--output", "json", ...common,
    ]));
    if (!historyResponse.Item) throw new Error(`使用価格履歴 ${verificationId} が見つからないか、180日の保存期間を過ぎている`);
    console.log(JSON.stringify({ reservation, pricingHistory: historyResponse.Item }, null, 2));
    return;
  }

  const modelId = required(values["model-id"], "--model-id");
  const key = JSON.stringify({ modelId: { S: modelId } });
  if (operation === "show") {
    console.log(runAws(["dynamodb", "get-item", "--table-name", table, "--key", key, "--consistent-read", "--output", "json", ...common]));
    return;
  }

  if (operation === "history") {
    const historyTable = stackOutput(values, common, "ModelPricingHistoryTableName");
    const valuesJson = JSON.stringify({ ":modelId": { S: modelId } });
    console.log(runAws([
      "dynamodb", "query", "--table-name", historyTable,
      "--key-condition-expression", "modelId = :modelId",
      "--expression-attribute-values", valuesJson,
      "--no-scan-index-forward", "--consistent-read", "--output", "json", ...common,
    ]));
    return;
  }

  const expectedVersion = required(values["expected-version"], "--expected-version");
  const names = JSON.stringify({ "#s": "status", "#v": "version" });
  if (operation === "disable") {
    const attributes = JSON.stringify({ ":inactive": { S: "INACTIVE" }, ":expected": { S: expectedVersion } });
    runAws([
      "dynamodb", "update-item", "--table-name", table, "--key", key,
      "--update-expression", "SET #s = :inactive",
      "--condition-expression", "#v = :expected",
      "--expression-attribute-names", names,
      "--expression-attribute-values", attributes,
      ...common,
    ]);
    console.log(`${modelId}を停止した。Runtimeは次の呼び出しからこのモデルを拒否する。`);
    return;
  }

}

main();
