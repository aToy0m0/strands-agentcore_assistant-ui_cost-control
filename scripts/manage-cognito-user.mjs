import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const UPPERCASE = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*_-+=";
const ALL_CHARACTERS = UPPERCASE + LOWERCASE + DIGITS + SYMBOLS;
const PASSWORD_LENGTH = 24;

export function generateCognitoPassword() {
  const characters = [
    pick(UPPERCASE),
    pick(LOWERCASE),
    pick(DIGITS),
    pick(SYMBOLS),
  ];

  while (characters.length < PASSWORD_LENGTH) {
    characters.push(pick(ALL_CHARACTERS));
  }

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }

  return characters.join("");
}

function pick(characters) {
  return characters[randomInt(characters.length)];
}

function runAws(arguments_) {
  const result = spawnSync("aws", arguments_, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim());
  }
  return result.stdout.trim();
}

function requireEmail(value) {
  if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error("--emailには有効なメールアドレスを指定すること");
  }
  return value;
}

function main() {
  const operation = process.argv[2];
  if (operation !== "create" && operation !== "set-password") {
    throw new Error("操作はcreate、set-passwordのいずれかを指定すること");
  }

  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      email: { type: "string" },
      profile: { type: "string" },
      region: { type: "string", default: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1" },
      stack: { type: "string", default: "agent-core-runtime-cost-control-stack" },
    },
    strict: true,
  });

  const email = requireEmail(values.email);
  const commonArguments = ["--region", values.region];
  if (values.profile) commonArguments.push("--profile", values.profile);

  const userPoolId = runAws([
    "cloudformation", "describe-stacks",
    "--stack-name", values.stack,
    "--query", "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue | [0]",
    "--output", "text",
    ...commonArguments,
  ]);
  if (!userPoolId || userPoolId === "None") {
    throw new Error(`スタック${values.stack}のUserPoolId出力を取得できない`);
  }

  if (operation === "create") {
    runAws([
      "cognito-idp", "admin-create-user",
      "--user-pool-id", userPoolId,
      "--username", email,
      "--user-attributes", `Name=email,Value=${email}`, "Name=email_verified,Value=true",
      "--message-action", "SUPPRESS",
      ...commonArguments,
    ]);
  }

  const password = generateCognitoPassword();
  runAws([
    "cognito-idp", "admin-set-user-password",
    "--user-pool-id", userPoolId,
    "--username", email,
    "--password", password,
    "--permanent",
    ...commonArguments,
  ]);

  console.log(operation === "create" ? "Cognitoユーザーを作成した。" : "Cognitoユーザーのパスワードを更新した。");
  console.log(`User Pool ID: ${userPoolId}`);
  console.log(`ログインID: ${email}`);
  console.log(`ログインパスワード: ${password}`);
  console.log("パスワードはこの出力でのみ表示する。安全な保管先へ記録すること。");
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) main();
