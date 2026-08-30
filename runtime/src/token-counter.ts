import { createHash, createHmac, type Hash, type Hmac } from "node:crypto";
import { BedrockRuntimeClient, CountTokensCommand, type CountTokensCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentityProvider, HttpRequest, SourceData } from "@smithy/types";
import type { TokenCounter as TokenCounterConfig } from "../../shared/model-catalog.js";

export type FormattedBedrockRequest = {
  messages?: unknown;
  system?: unknown;
  toolConfig?: unknown;
  additionalModelRequestFields?: unknown;
};

export interface TokenCounter {
  count(request: FormattedBedrockRequest): Promise<number>;
}

class NodeSha256 {
  private readonly hash: Hash | Hmac;

  constructor(secret?: SourceData) {
    this.hash = secret === undefined
      ? createHash("sha256")
      : createHmac("sha256", sourceBuffer(secret));
  }

  update(data: SourceData, encoding?: "utf8" | "ascii" | "latin1"): void {
    if (typeof data === "string") {
      if (encoding === undefined) this.hash.update(data);
      else this.hash.update(data, encoding);
    } else this.hash.update(sourceBuffer(data));
  }

  async digest(): Promise<Uint8Array> {
    return this.hash.digest();
  }
}

function sourceBuffer(value: SourceData): Buffer {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export class BedrockRuntimeTokenCounter implements TokenCounter {
  constructor(private readonly client: BedrockRuntimeClient, private readonly modelId: string) {}

  async count(request: FormattedBedrockRequest): Promise<number> {
    const converse = {
      ...(request.messages ? { messages: request.messages } : {}),
      ...(request.system ? { system: request.system } : {}),
      ...(request.toolConfig ? { toolConfig: request.toolConfig } : {}),
    } as NonNullable<NonNullable<CountTokensCommandInput["input"]>["converse"]>;
    const response = await this.client.send(new CountTokensCommand({ modelId: this.modelId, input: { converse } }));
    return validTokenCount(response.inputTokens, "Bedrock Runtime CountTokens");
  }
}

export class BedrockMantleAnthropicTokenCounter implements TokenCounter {
  private readonly signer: SignatureV4;
  private readonly hostname: string;

  constructor(region: string, credentials: AwsCredentialIdentityProvider, private readonly modelId: string) {
    this.hostname = `bedrock-mantle.${region}.api.aws`;
    this.signer = new SignatureV4({
      credentials,
      region,
      service: "bedrock-mantle",
      sha256: NodeSha256,
    });
  }

  async count(request: FormattedBedrockRequest): Promise<number> {
    const body = JSON.stringify(toAnthropicCountTokensRequest(request, this.modelId));
    const signed = await this.signer.sign({
      protocol: "https:",
      hostname: this.hostname,
      method: "POST",
      path: "/anthropic/v1/messages/count_tokens",
      headers: {
        host: this.hostname,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body,
    } satisfies HttpRequest);
    const response = await fetch(`https://${this.hostname}${signed.path}`, {
      method: signed.method,
      headers: signed.headers,
      body,
    });
    const payload = await response.json() as unknown;
    if (!response.ok) throw new Error(`Bedrock Mantle CountTokens failed (${response.status}): ${mantleError(payload)}`);
    return validTokenCount(record(payload, "Mantle response").input_tokens, "Bedrock Mantle CountTokens");
  }
}

export function createTokenCounter(region: string, config: TokenCounterConfig): TokenCounter {
  if (config.kind === "unsupported") throw new Error(config.reason);
  const client = new BedrockRuntimeClient({ region });
  if (config.kind === "bedrock-runtime") return new BedrockRuntimeTokenCounter(client, config.modelId);
  return new BedrockMantleAnthropicTokenCounter(region, client.config.credentials, config.modelId);
}

export function toAnthropicCountTokensRequest(request: FormattedBedrockRequest, modelId: string): Record<string, unknown> {
  if (!Array.isArray(request.messages)) throw new Error("Bedrock formatted messages are required for token counting");
  const result: Record<string, unknown> = {
    model: modelId,
    messages: request.messages.map((message, index) => anthropicMessage(message, index)),
  };
  if (request.system !== undefined) result.system = anthropicSystem(request.system);
  if (request.toolConfig !== undefined) Object.assign(result, anthropicTools(request.toolConfig));
  if (request.additionalModelRequestFields !== undefined) {
    const additional = record(request.additionalModelRequestFields, "additionalModelRequestFields");
    if (additional.thinking !== undefined) result.thinking = additional.thinking;
    if (additional.output_config !== undefined) result.output_config = additional.output_config;
  }
  return result;
}

function anthropicMessage(value: unknown, index: number): Record<string, unknown> {
  const message = record(value, `messages[${index}]`);
  if (message.role !== "user" && message.role !== "assistant") throw new Error(`messages[${index}].role is unsupported`);
  if (!Array.isArray(message.content)) throw new Error(`messages[${index}].content must be an array`);
  return { role: message.role, content: message.content.map((block, blockIndex) => anthropicContent(block, `messages[${index}].content[${blockIndex}]`)) };
}

function anthropicContent(value: unknown, name: string): Record<string, unknown> {
  const block = record(value, name);
  if (typeof block.text === "string") return { type: "text", text: block.text };
  if (block.image !== undefined) return anthropicMedia(block.image, name, "image");
  if (block.document !== undefined) return anthropicMedia(block.document, name, "document");
  if (block.toolUse !== undefined) {
    const tool = record(block.toolUse, `${name}.toolUse`);
    return { type: "tool_use", id: string(tool.toolUseId, `${name}.toolUse.toolUseId`), name: string(tool.name, `${name}.toolUse.name`), input: tool.input };
  }
  if (block.toolResult !== undefined) {
    const tool = record(block.toolResult, `${name}.toolResult`);
    if (!Array.isArray(tool.content)) throw new Error(`${name}.toolResult.content must be an array`);
    return {
      type: "tool_result",
      tool_use_id: string(tool.toolUseId, `${name}.toolResult.toolUseId`),
      content: tool.content.map((content, index) => anthropicToolResultContent(content, `${name}.toolResult.content[${index}]`)),
      ...(tool.status === "error" ? { is_error: true } : {}),
    };
  }
  if (block.reasoningContent !== undefined) {
    const reasoning = record(block.reasoningContent, `${name}.reasoningContent`);
    if (reasoning.reasoningText !== undefined) {
      const text = record(reasoning.reasoningText, `${name}.reasoningContent.reasoningText`);
      return { type: "thinking", thinking: string(text.text, `${name}.reasoningContent.reasoningText.text`), signature: string(text.signature, `${name}.reasoningContent.reasoningText.signature`) };
    }
    if (reasoning.redactedContent !== undefined) return { type: "redacted_thinking", data: base64(reasoning.redactedContent, `${name}.reasoningContent.redactedContent`) };
  }
  throw new Error(`${name} cannot be represented by Anthropic CountTokens without changing the request`);
}

function anthropicToolResultContent(value: unknown, name: string): Record<string, unknown> {
  const block = record(value, name);
  if (typeof block.text === "string") return { type: "text", text: block.text };
  if (block.json !== undefined) return { type: "text", text: JSON.stringify(block.json) };
  if (block.image !== undefined) return anthropicMedia(block.image, name, "image");
  if (block.document !== undefined) return anthropicMedia(block.document, name, "document");
  throw new Error(`${name} is unsupported by Anthropic CountTokens`);
}

function anthropicMedia(value: unknown, name: string, type: "image" | "document"): Record<string, unknown> {
  const media = record(value, `${name}.${type}`);
  const source = record(media.source, `${name}.${type}.source`);
  if (source.bytes === undefined) throw new Error(`${name}.${type} must use an inline byte source for Anthropic CountTokens`);
  const format = string(media.format, `${name}.${type}.format`);
  const mediaType = type === "image" ? `image/${format === "jpg" ? "jpeg" : format}` : format === "pdf" ? "application/pdf" : "text/plain";
  return { type, source: { type: "base64", media_type: mediaType, data: base64(source.bytes, `${name}.${type}.source.bytes`) } };
}

function anthropicSystem(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("system must be an array");
  return value.map((block, index) => {
    const item = record(block, `system[${index}]`);
    return { type: "text", text: string(item.text, `system[${index}].text`) };
  });
}

function anthropicTools(value: unknown): Record<string, unknown> {
  const config = record(value, "toolConfig");
  if (!Array.isArray(config.tools)) throw new Error("toolConfig.tools must be an array");
  const tools = config.tools.map((value, index) => {
    const wrapper = record(value, `toolConfig.tools[${index}]`);
    const tool = record(wrapper.toolSpec, `toolConfig.tools[${index}].toolSpec`);
    const schema = record(tool.inputSchema, `toolConfig.tools[${index}].toolSpec.inputSchema`);
    return {
      name: string(tool.name, `toolConfig.tools[${index}].toolSpec.name`),
      description: string(tool.description, `toolConfig.tools[${index}].toolSpec.description`),
      input_schema: schema.json,
    };
  });
  return { tools, ...(config.toolChoice === undefined ? {} : { tool_choice: anthropicToolChoice(config.toolChoice) }) };
}

function anthropicToolChoice(value: unknown): Record<string, unknown> {
  const choice = record(value, "toolConfig.toolChoice");
  if (choice.auto !== undefined) return { type: "auto" };
  if (choice.any !== undefined) return { type: "any" };
  if (choice.tool !== undefined) return { type: "tool", name: string(record(choice.tool, "toolConfig.toolChoice.tool").name, "toolConfig.toolChoice.tool.name") };
  throw new Error("toolConfig.toolChoice is unsupported by Anthropic CountTokens");
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function base64(value: unknown, name: string): string {
  if (typeof value === "string") return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  throw new Error(`${name} must be bytes`);
}

function validTokenCount(value: unknown, source: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${source} did not return a valid input token count`);
  return value as number;
}

function mantleError(value: unknown): string {
  try {
    const error = record(record(value, "Mantle error response").error, "Mantle error response.error");
    return typeof error.message === "string" ? error.message : JSON.stringify(value);
  } catch {
    return JSON.stringify(value);
  }
}
