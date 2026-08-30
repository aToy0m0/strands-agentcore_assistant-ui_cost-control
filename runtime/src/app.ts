import { EventType, RunAgentInputSchema, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { identityFromAuthorization, AuthenticationError } from "./auth.js";
import { createRuntimeLogger, parseLogSettings, type RuntimeLogger } from "./logging.js";
import type { AgentCoreMemory } from "./memory.js";

export type AgentOutputEvent =
  | { type: "reasoning"; text: string }
  | { type: "reasoning-end" }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; result: unknown; error?: string }
  | { type: "interrupt"; interrupts: Array<{ id: string; reason: string; message?: string; metadata?: Record<string, unknown> }> }
  | { type: "text"; text: string };

export type InvocationIdentity = { actorId: string; authorization: string; limitProfileId?: string };
export type StreamAgent = (input: RunAgentInput, cancelSignal: AbortSignal, identity: InvocationIdentity) => AsyncIterable<AgentOutputEvent>;

const historyOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("memory.listThreads") }).strict(),
  z.object({ operation: z.literal("memory.loadThread"), sessionId: z.string().min(33).max(100) }).strict(),
  z.object({ operation: z.literal("memory.deleteThread"), sessionId: z.string().min(33).max(100) }).strict(),
]);

type AppServices = {
  memory?: AgentCoreMemory;
  logger?: RuntimeLogger;
};

export function promptFrom(input: RunAgentInput): string {
  const message = [...input.messages].reverse().find((item) => item.role === "user");
  if (!message) throw new Error("A user message is required");
  if (typeof message.content === "string") return message.content;
  const prompt = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  if (!prompt) throw new Error("A text user message is required");
  return prompt;
}

export function createApp(streamAgent: StreamAgent, services: AppServices = {}) {
  const logger = services.logger ?? createRuntimeLogger(parseLogSettings(process.env));
  const app = express();
  app.get("/ping", (_request, response) => response.json({ status: "Healthy" }));
  app.post("/invocations", express.json({ limit: "4mb" }), async (request, response) => {
    const authorization = request.get("authorization");
    let identity: ReturnType<typeof identityFromAuthorization>;
    try {
      // AgentCore RuntimeのJWT Authorizerが検証済みのトークンだけを転送する。
      // actorIdはクライアント入力ではなく、その検証済みJWTのsubから確定する。
      identity = identityFromAuthorization(authorization);
    } catch (error) {
      if (error instanceof AuthenticationError) return response.status(401).json({ error: error.message });
      throw error;
    }

    const { actorId } = identity;
    const historyOperation = historyOperationSchema.safeParse(request.body);
    if (historyOperation.success) {
      if (!services.memory) return response.status(503).json({ error: "AgentCore Memory is unavailable" });
      try {
        if (historyOperation.data.operation === "memory.listThreads") {
          return response.json({ threads: await services.memory.listThreads(actorId) });
        }
        if (historyOperation.data.operation === "memory.loadThread") {
          return response.json({ messages: await services.memory.loadMessages(actorId, historyOperation.data.sessionId) });
        }
        await services.memory.deleteThread(actorId, historyOperation.data.sessionId);
        return response.status(204).end();
      } catch (error) {
        logger.error("memory.operation.failed", {
          operation: historyOperation.data.operation,
          message: error instanceof Error ? error.message : String(error),
        });
        return response.status(500).json({ error: "チャット履歴の操作に失敗しました" });
      }
    }

    const parsed = RunAgentInputSchema.safeParse(request.body);
    if (!parsed.success) {
      logger.error("invocation.rejected", { reason: "invalid AG-UI RunAgentInput", issues: parsed.error.issues });
      return response.status(400).json({ error: "Invalid AG-UI RunAgentInput", issues: parsed.error.issues });
    }
    const input = parsed.data;
    logger.log("request", "invocation.received", { threadId: input.threadId, runId: input.runId, messageCount: input.messages.length, messages: input.messages });
    const eventEncoder = new EventEncoder({ accept: request.headers.accept ?? "text/event-stream" });
    response.status(200);
    response.setHeader("Content-Type", eventEncoder.getContentType());
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const send = (event: BaseEvent) => response.write(eventEncoder.encode(event));
    const cancellation = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) cancellation.abort();
    });
    let reasoningContextId: string | undefined;
    let reasoningMessageId: string | undefined;
    let textMessageId: string | undefined;
    // AG-UIクライアントはmessageIdごとにテキストパートを1つ保持し、同じIDのdeltaは既存パートへ追記する。
    // 全テキストで1つのIDを使い回すと、ツール実行後の本文が先頭のパートへ吸収され、
    // 間に挟まるツールや思考が末尾へ押し出される。区間ごとに新しいIDを振って表示順を保つ。
    let lastTextMessageId: string | undefined;
    const assistantMessageId = crypto.randomUUID();
    const closeReasoning = () => {
      if (!reasoningContextId || !reasoningMessageId) return;
      send({ type: EventType.REASONING_MESSAGE_END, messageId: reasoningMessageId });
      send({ type: EventType.REASONING_END, messageId: reasoningContextId });
      reasoningContextId = undefined;
      reasoningMessageId = undefined;
    };
    const closeText = () => {
      if (!textMessageId) return;
      send({ type: EventType.TEXT_MESSAGE_END, messageId: textMessageId });
      textMessageId = undefined;
    };
    try {
      send({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
      let hasText = false;
      const startedAt = Date.now();
      let assistantText = "";
      let reasoningLength = 0;
      let interrupts: Extract<AgentOutputEvent, { type: "interrupt" }>["interrupts"] | undefined;

      for await (const event of streamAgent(input, cancellation.signal, { ...identity, authorization: authorization! })) {
        if (response.destroyed || response.writableEnded) return;
        if (event.type === "reasoning-end") {
          closeReasoning();
          continue;
        }
        if (event.type === "reasoning") {
          if (!event.text) continue;
          closeText();
          if (!reasoningContextId || !reasoningMessageId) {
            reasoningContextId = crypto.randomUUID();
            reasoningMessageId = crypto.randomUUID();
            send({ type: EventType.REASONING_START, messageId: reasoningContextId });
            send({ type: EventType.REASONING_MESSAGE_START, messageId: reasoningMessageId, role: "reasoning" });
          }
          reasoningLength += event.text.length;
          send({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningMessageId, delta: event.text });
          continue;
        }

        if (event.type === "tool-start") {
          closeReasoning();
          closeText();
          // 直前のテキスト区間を親にすると、クライアントはそのテキストの直後へツールを差し込む。
          logger.log("tool", "tool.started", { threadId: input.threadId, toolCallId: event.id, name: event.name, input: event.input });
          send({ type: EventType.TOOL_CALL_START, toolCallId: event.id, toolCallName: event.name, parentMessageId: lastTextMessageId ?? assistantMessageId });
          send({ type: EventType.TOOL_CALL_ARGS, toolCallId: event.id, delta: JSON.stringify(event.input) });
          send({ type: EventType.TOOL_CALL_END, toolCallId: event.id });
          continue;
        }

        if (event.type === "tool-result") {
          logger.log("tool", "tool.completed", { threadId: input.threadId, toolCallId: event.id, result: event.result, ...(event.error ? { error: event.error } : {}) });
          closeReasoning();
          closeText();
          send({
            type: EventType.TOOL_CALL_RESULT,
            messageId: crypto.randomUUID(),
            toolCallId: event.id,
            content: JSON.stringify({ result: event.result, ...(event.error ? { error: event.error } : {}) }),
            role: "tool",
          });
          continue;
        }

        if (event.type === "interrupt") {
          closeReasoning();
          closeText();
          interrupts = event.interrupts;
          continue;
        }

        closeReasoning();
        if (!textMessageId) {
          textMessageId = lastTextMessageId === undefined ? assistantMessageId : crypto.randomUUID();
          lastTextMessageId = textMessageId;
          send({ type: EventType.TEXT_MESSAGE_START, messageId: textMessageId, role: "assistant" });
        }
        hasText = true;
        assistantText += event.text;
        send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: textMessageId, delta: event.text });
      }
      closeReasoning();
      closeText();
      if (interrupts) {
        send({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
          outcome: { type: "interrupt", interrupts },
        });
        response.end();
        return;
      }
      if (!hasText) throw new Error("Strands returned no assistant text");
      logger.log("model", "assistant.completed", { threadId: input.threadId, runId: input.runId, elapsedMs: Date.now() - startedAt, reasoningLength, text: assistantText });
      send({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
      response.end();
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      closeReasoning();
      closeText();
      logger.error("invocation.failed", { threadId: input.threadId, runId: input.runId, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      send({ type: EventType.RUN_ERROR, message: "エージェントの実行に失敗しました", code: "AGENT_INVOCATION_FAILED" });
      response.end();
    }
  });
  const invalidJson: ErrorRequestHandler = (error, _request, response, next) => {
    if (error instanceof SyntaxError) return void response.status(400).json({ error: "Request body must be valid JSON" });
    next(error);
  };
  app.use(invalidJson);
  return app;
}
