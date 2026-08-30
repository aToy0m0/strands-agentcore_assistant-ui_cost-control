import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const envPath = resolve(projectRoot, ".env");
if (!existsSync(envPath)) throw new Error(`Integration test environment is missing: ${envPath}`);
process.loadEnvFile(envPath);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for BFF integration tests`);
  return value;
}

function roleUrl(role, passwordName) {
  const url = new URL("postgresql://127.0.0.1");
  url.username = role;
  url.password = required(passwordName);
  url.port = required("POSTGRES_PORT");
  url.pathname = `/${required("POSTGRES_DB")}`;
  return url.toString();
}

const environment = {
  ...process.env,
  DATABASE_URL: roleUrl("workmate_app", "APP_DB_PASSWORD"),
  AUTH_DATABASE_URL: roleUrl("workmate_auth", "AUTH_DB_PASSWORD"),
  DATABASE_POOL_MAX: "2",
};
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) throw new Error("npm_execpath is required for BFF integration tests");

function run(args, cwd = projectRoot) {
  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd,
    env: environment,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["run", "test:bff", "--prefix", "runtime"]);
