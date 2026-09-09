import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_STACK = "agent-core-runtime-cost-control-stack";
const READ_ONLY_PROFILE = "default";
const NANO_USD_PER_USD = 1_000_000_000n;

function runAws(arguments_) {
  const result = spawnSync("aws", arguments_, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout.trim();
}

export function parseAwsJson(output) {
  return output === "" ? {} : JSON.parse(output);
}

function stackOutput(outputKey, stack, region) {
  const value = runAws([
    "cloudformation", "describe-stacks", "--stack-name", stack,
    "--query", `Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue | [0]`,
    "--output", "text", "--region", region, "--profile", READ_ONLY_PROFILE,
  ]);
  if (!value || value === "None") throw new Error(`stack output ${outputKey} was not found`);
  return value;
}

function utcMonth(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function requireMonth(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) throw new Error("--month must be YYYY-MM");
  return value;
}

function npmBoolean(value) {
  return typeof value === "string" && ["1", "true", "yes"].includes(value.toLowerCase());
}

export function resolveCliOptions(args, environment = process.env, now = new Date()) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      region: { type: "string" },
      stack: { type: "string" },
      month: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 2) throw new Error("positional arguments must be [region] [month]");
  const region = values.region ?? environment.npm_config_region ?? positionals[0]
    ?? environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION ?? DEFAULT_REGION;
  const stack = values.stack ?? environment.npm_config_stack ?? DEFAULT_STACK;
  const month = requireMonth(values.month ?? environment.npm_config_month ?? positionals[1] ?? utcMonth(now));
  const json = values.json ?? npmBoolean(environment.npm_config_json);
  return { region, stack, month, json };
}

function numberAttribute(item, name, defaultValue = undefined) {
  const value = item?.[name]?.N;
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (value === undefined || !/^\d+$/u.test(value)) throw new Error(`${name} is missing or invalid`);
  return BigInt(value);
}

function safeTokenAttribute(item, name) {
  const value = numberAttribute(item, name, 0n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} exceeds the safe integer range`);
  return Number(value);
}

export function nanoUsdToUsd(value) {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / NANO_USD_PER_USD;
  const fraction = (absolute % NANO_USD_PER_USD).toString().padStart(9, "0").replace(/0+$/u, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function buildCostStatus({ month, configurationItem, monthlyItem, usageItems }) {
  const limitNanoUsd = numberAttribute(configurationItem, "limitNanoUsd");
  if (limitNanoUsd <= 0n) throw new Error("limitNanoUsd must be greater than zero");
  const spentNanoUsd = numberAttribute(monthlyItem, "spentNanoUsd", 0n);
  const statusCounts = {};
  const models = new Map();
  let eventCostNanoUsd = 0n;

  for (const item of usageItems) {
    const status = item.status?.S;
    const modelId = item.modelId?.S;
    if (!status || !modelId) throw new Error("usage item status or modelId is missing");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const current = models.get(modelId) ?? { modelId, calls: 0, inputTokens: 0, outputTokens: 0, costNanoUsd: 0n };
    current.calls += 1;
    current.inputTokens += safeTokenAttribute(item, "inputTokens");
    current.outputTokens += safeTokenAttribute(item, "outputTokens");
    const costNanoUsd = numberAttribute(item, "costNanoUsd", 0n);
    current.costNanoUsd += costNanoUsd;
    if (status === "APPLIED") eventCostNanoUsd += costNanoUsd;
    models.set(modelId, current);
  }

  return {
    month,
    limitNanoUsd,
    spentNanoUsd,
    remainingNanoUsd: limitNanoUsd - spentNanoUsd,
    usagePercent: Number((spentNanoUsd * 10_000n + limitNanoUsd / 2n) / limitNanoUsd) / 100,
    eventCostNanoUsd,
    ledgerMatchesEvents: spentNanoUsd === eventCostNanoUsd,
    statusCounts,
    models: [...models.values()].sort((left, right) => left.modelId.localeCompare(right.modelId)),
  };
}

function loadCostStatus(month, stack, region) {
  const tableName = stackOutput("BudgetLedgerTableName", stack, region);
  const budgetScopeId = stackOutput("BudgetScopeId", stack, region);
  const common = ["--region", region, "--profile", READ_ONLY_PROFILE, "--output", "json"];
  const key = (sk) => JSON.stringify({ PK: { S: `APP#${budgetScopeId}` }, SK: { S: sk } });
  const configuration = parseAwsJson(runAws([
    "dynamodb", "get-item", "--table-name", tableName, "--key", key("CONFIG"), "--consistent-read", ...common,
  ]));
  const monthly = parseAwsJson(runAws([
    "dynamodb", "get-item", "--table-name", tableName, "--key", key(`MONTH#${month}`), "--consistent-read", ...common,
  ]));
  const usage = parseAwsJson(runAws([
    "dynamodb", "query", "--table-name", tableName,
    "--key-condition-expression", "PK = :pk AND begins_with(SK, :usage)",
    "--filter-expression", "#month = :month",
    "--expression-attribute-names", JSON.stringify({ "#month": "month" }),
    "--expression-attribute-values", JSON.stringify({
      ":pk": { S: `APP#${budgetScopeId}` }, ":usage": { S: "USAGE#" }, ":month": { S: month },
    }),
    "--consistent-read", ...common,
  ]));
  if (!configuration.Item) throw new Error("budget configuration was not found");
  return buildCostStatus({
    month,
    configurationItem: configuration.Item,
    monthlyItem: monthly.Item,
    usageItems: usage.Items ?? [],
  });
}

function printableStatus(status) {
  return {
    month: status.month,
    limitUsd: nanoUsdToUsd(status.limitNanoUsd),
    spentUsd: nanoUsdToUsd(status.spentNanoUsd),
    remainingUsd: nanoUsdToUsd(status.remainingNanoUsd),
    usagePercent: status.usagePercent,
    ledgerMatchesEvents: status.ledgerMatchesEvents,
    statusCounts: status.statusCounts,
    models: status.models.map((model) => ({
      ...model,
      costNanoUsd: undefined,
      costUsd: nanoUsdToUsd(model.costNanoUsd),
    })),
  };
}

function printHumanReadable(status, region) {
  console.log(`料金状況 (${status.month}, UTC / ${region})`);
  console.log(`月額上限: $${nanoUsdToUsd(status.limitNanoUsd)}`);
  console.log(`確定費用: $${nanoUsdToUsd(status.spentNanoUsd)}`);
  console.log(`残額:     $${nanoUsdToUsd(status.remainingNanoUsd)}`);
  console.log(`消化率:   ${status.usagePercent.toFixed(2)}%`);
  console.log("");
  console.log("利用結果:");
  if (Object.keys(status.statusCounts).length === 0) console.log("  記録なし");
  for (const [name, count] of Object.entries(status.statusCounts).sort()) console.log(`  ${name}: ${count}件`);
  console.log("");
  console.log("モデル別:");
  if (status.models.length === 0) console.log("  記録なし");
  for (const model of status.models) {
    console.log(`  ${model.modelId}: ${model.calls}件 / 入力 ${model.inputTokens} tokens / 出力 ${model.outputTokens} tokens / $${nanoUsdToUsd(model.costNanoUsd)}`);
  }
  if (!status.ledgerMatchesEvents) {
    console.log("");
    console.warn(`警告: 月次確定費用と当月APPLIEDイベント合計が一致しません (イベント合計: $${nanoUsdToUsd(status.eventCostNanoUsd)})`);
  }
}

function main() {
  const options = resolveCliOptions(process.argv.slice(2));
  const status = loadCostStatus(options.month, options.stack, options.region);
  if (options.json) console.log(JSON.stringify(printableStatus(status), null, 2));
  else printHumanReadable(status, options.region);
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
