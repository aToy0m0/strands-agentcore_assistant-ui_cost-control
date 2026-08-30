import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  GetAgentRuntimeCommand,
  ListAgentRuntimesCommand,
  UpdateAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  GetBucketEncryptionCommand,
  GetBucketLocationCommand,
  GetPublicAccessBlockCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const region = required("AWS_REGION");
if (region !== "us-east-1") {
  throw new Error(`AWS_REGION must be us-east-1 for the 11 baseline: ${region}`);
}
const bucket = required("CODEZIP_S3_BUCKET");
const roleArn = required("AGENT_RUNTIME_ROLE_ARN");
const runtimeName = required("AGENT_RUNTIME_NAME");
const runtimeId = process.env.AGENT_RUNTIME_ID?.trim();
const checkOnly = process.argv.includes("--check");
const archive = await readFile("deployment_package.zip");
const compressedLimit = 250 * 1024 * 1024;
if (archive.byteLength > compressedLimit) {
  throw new Error(`Compressed package exceeds 250 MB: ${archive.byteLength}`);
}
const digest = createHash("sha256").update(archive).digest("hex");
const key = `${runtimeName}/${digest}/deployment_package.zip`;
const identity = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
if (!identity.Account) throw new Error("AWS STS returned no account ID");

const roleMatch = /^arn:aws:iam::([0-9]{12}):role\/(.+)$/.exec(roleArn);
if (!roleMatch) throw new Error("AGENT_RUNTIME_ROLE_ARN must be an IAM role ARN");
if (roleMatch[1] !== identity.Account) {
  throw new Error(`AGENT_RUNTIME_ROLE_ARN must belong to caller account ${identity.Account}`);
}
if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(runtimeName)) {
  throw new Error("AGENT_RUNTIME_NAME must start with a letter and contain at most 48 letters, digits, or underscores");
}

const s3 = new S3Client({ region });
const [location, publicAccess, encryption] = await Promise.all([
  s3.send(new GetBucketLocationCommand({ Bucket: bucket, ExpectedBucketOwner: identity.Account })),
  s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket, ExpectedBucketOwner: identity.Account })),
  s3.send(new GetBucketEncryptionCommand({ Bucket: bucket, ExpectedBucketOwner: identity.Account })),
]);
const bucketRegion = location.LocationConstraint || "us-east-1";
if (bucketRegion !== region) throw new Error(`S3 bucket region must be ${region}: ${bucketRegion}`);
const block = publicAccess.PublicAccessBlockConfiguration;
if (!block?.BlockPublicAcls || !block.IgnorePublicAcls || !block.BlockPublicPolicy || !block.RestrictPublicBuckets) {
  throw new Error("CodeZip S3 bucket must enable all four Block Public Access settings");
}
const encryptionRules = encryption.ServerSideEncryptionConfiguration?.Rules ?? [];
if (!encryptionRules.some((rule) => {
  const algorithm = rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
  return algorithm === "AES256" || algorithm === "aws:kms";
})) {
  throw new Error("CodeZip S3 bucket default encryption must use SSE-S3 or SSE-KMS");
}

const control = new BedrockAgentCoreControlClient({ region });
if (runtimeId) {
  const current = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
  if (current.agentRuntimeName !== runtimeName) {
    throw new Error(`AGENT_RUNTIME_ID belongs to ${current.agentRuntimeName ?? "an unnamed runtime"}, not ${runtimeName}`);
  }
  if (!current.agentRuntimeArn?.startsWith(`arn:aws:bedrock-agentcore:${region}:${identity.Account}:runtime/`)) {
    throw new Error("AGENT_RUNTIME_ID does not belong to the selected account and region");
  }
} else {
  let nextToken: string | undefined;
  do {
    const page = await control.send(new ListAgentRuntimesCommand({ maxResults: 100, nextToken }));
    const existing = page.agentRuntimes?.find((candidate) => candidate.agentRuntimeName === runtimeName);
    if (existing) {
      throw new Error(`Runtime ${runtimeName} already exists as ${existing.agentRuntimeId}; set AGENT_RUNTIME_ID to update it`);
    }
    nextToken = page.nextToken;
  } while (nextToken);
}

console.log(JSON.stringify({
  mode: checkOnly ? "check" : runtimeId ? "update" : "create",
  account: identity.Account,
  region,
  bucket,
  runtimeName,
  runtimeId: runtimeId ?? null,
  compressedBytes: archive.byteLength,
  sha256: digest,
}, null, 2));
if (checkOnly) process.exit(0);

await s3.send(new PutObjectCommand({
  Bucket: bucket, Key: key, Body: archive, ExpectedBucketOwner: identity.Account,
  Metadata: { sha256: digest }, ServerSideEncryption: "AES256",
}));
console.log(`Uploaded s3://${bucket}/${key}`);
const artifact = {
  codeConfiguration: {
    code: { s3: { bucket, prefix: key } },
    runtime: "NODE_22" as const,
    entryPoint: ["dist/app.js"],
  },
};
const lifecycleConfiguration = { idleRuntimeSessionTimeout: 300, maxLifetime: 1800 };
const metadataConfiguration = { requireMMDSV2: true };
const protocolConfiguration = { serverProtocol: "AGUI" as const };
const environmentVariables = { AWS_REGION: region };
const clientToken = createHash("sha256").update(`${region}:${identity.Account}:${runtimeName}:${runtimeId ?? "create"}:${digest}`).digest("hex");
const response = runtimeId
  ? await control.send(new UpdateAgentRuntimeCommand({ agentRuntimeId: runtimeId, agentRuntimeArtifact: artifact, networkConfiguration: { networkMode: "PUBLIC" }, roleArn, lifecycleConfiguration, metadataConfiguration, protocolConfiguration, environmentVariables, clientToken }))
  : await control.send(new CreateAgentRuntimeCommand({ agentRuntimeName: runtimeName, agentRuntimeArtifact: artifact, networkConfiguration: { networkMode: "PUBLIC" }, roleArn, lifecycleConfiguration, protocolConfiguration, environmentVariables, clientToken }));
console.log(JSON.stringify({
  runtimeArn: response.agentRuntimeArn,
  runtimeId: response.agentRuntimeId,
  status: response.status,
  s3Key: key,
}, null, 2));
