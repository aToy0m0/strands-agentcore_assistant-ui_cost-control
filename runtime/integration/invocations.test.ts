import { EventType } from "@ag-ui/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invokeRuntime = vi.fn();
vi.mock("@/server/agentcore/invoke", () => ({ invokeRuntime }));

const tenantId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";
const threadId = "0198d773-8f67-7678-baba-668a48c4d76f";
vi.mock("@/server/auth/context", () => ({
  getAuthContext: vi.fn(async () => ({ tenantId, userId, displayName: "Integration User" })),
}));

function runtimeStream() {
  const assistantMessageId = "assistant-1";
  const events = [
    { type: EventType.RUN_STARTED, threadId, runId: "run-abc" },
    { type: EventType.TEXT_MESSAGE_START, messageId: assistantMessageId, role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: assistantMessageId, delta: "統合テスト応答" },
    { type: EventType.TEXT_MESSAGE_END, messageId: assistantMessageId },
    { type: EventType.RUN_FINISHED, threadId, runId: "run-abc" },
  ];
  const body = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
}

function hangingRuntimeStream() {
  const events = [
    { type: EventType.RUN_STARTED, threadId, runId: "run-cancel" },
    { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-cancel", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "assistant-cancel", delta: "途中まで" },
  ];
  const body = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
    },
  });
}

describe("POST /api/runtime/invocations", () => {
  beforeAll(() => {
    process.env.APP_ENV = "local";
    process.env.APP_AUTH_MODE = "local";
    process.env.LOCAL_TENANT_ID = tenantId;
    process.env.LOCAL_USER_ID = userId;
    process.env.AWS_REGION = "us-east-1";
    process.env.AGENTCORE_RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/test";
    process.env.AGENTCORE_RUNTIME_QUALIFIER = "DEFAULT";
    process.env.AGENTCORE_INVOCATION_TIMEOUT_MS = "30000";
  });

  beforeEach(async () => {
    const { authPrismaClient, tenantTransaction } = await import("@/server/db/client");
    const auth = { tenantId, userId, displayName: "Integration User" };
    await tenantTransaction(auth, async (db) => {
      await db.projectConversation.deleteMany({ where: { conversationId: threadId } });
      await db.message.deleteMany({ where: { conversationId: threadId } });
      await db.agentRun.deleteMany({ where: { conversationId: threadId } });
      await db.conversation.deleteMany({ where: { id: threadId } });
    });
    await authPrismaClient().appUser.upsert({
      where: { id: userId },
      create: {
        id: userId,
        tenantId,
        loginId: "integration-user",
        displayName: "Integration User",
        passwordHash: "not-used-by-integration-tests",
      },
      update: { tenantId, displayName: "Integration User" },
    });
    await tenantTransaction(auth, (db) => db.conversation.create({
      data: { id: threadId, tenantId, ownerUserId: userId, title: "新しいチャット" },
    }));
    invokeRuntime.mockReset();
    invokeRuntime.mockResolvedValue({
      result: {
        response: { transformToWebStream: runtimeStream },
        statusCode: 200,
        contentType: "text/event-stream",
      },
    });
  });

  it("accepts opaque AG-UI IDs and maps them to internal UUIDs", async () => {
    const body = JSON.stringify({
      threadId,
      runId: "run-abc",
      state: {},
      messages: [{ id: "message-xyz", role: "user", content: "こんにちは" }],
      tools: [],
      context: [],
      forwardedProps: { inference: { model: "claude-haiku-4-5", reasoning: { enabled: true, effort: "medium" } } },
    });
    const { POST } = await import("@/app/api/runtime/invocations/route");
    const response = await POST(new Request("http://localhost/api/runtime/invocations", { method: "POST", body }));

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.text()).toContain(EventType.RUN_FINISHED);
    expect(invokeRuntime).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(invokeRuntime.mock.calls[0]?.[0].body)).toBe(body);

    const { tenantTransaction } = await import("@/server/db/client");
    await tenantTransaction({ tenantId, userId, displayName: "Integration User" }, async (db) => {
      const run = await db.agentRun.findUniqueOrThrow({
        where: { conversationId_aguiRunId: { conversationId: threadId, aguiRunId: "run-abc" } },
      });
      expect(run.id).not.toBe("run-abc");
      expect(run.status).toBe("SUCCEEDED");
      const messages = await db.message.findMany({ where: { conversationId: threadId }, orderBy: { sequence: "asc" } });
      expect(messages.map((message) => message.aguiMessageId)).toEqual(["message-xyz", "assistant-1"]);
      expect(messages.every((message) => /^[0-9a-f-]{36}$/i.test(message.id))).toBe(true);
      const conversation = await db.conversation.findUniqueOrThrow({ where: { id: threadId } });
      expect(conversation.title).toBe("こんにちは");
    });
  });

  it("returns 409 for a duplicate without changing the completed run", async () => {
    const body = JSON.stringify({
      threadId,
      runId: "run-abc",
      state: {},
      messages: [{ id: "message-xyz", role: "user", content: "こんにちは" }],
      tools: [],
      context: [],
      forwardedProps: { inference: { model: "claude-haiku-4-5", reasoning: { enabled: true, effort: "medium" } } },
    });
    const { POST } = await import("@/app/api/runtime/invocations/route");
    const first = await POST(new Request("http://localhost/api/runtime/invocations", { method: "POST", body }));
    await first.text();
    const duplicate = await POST(new Request("http://localhost/api/runtime/invocations", { method: "POST", body }));

    expect(duplicate.status, await duplicate.clone().text()).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "DUPLICATE_INVOCATION" });
    const { tenantTransaction } = await import("@/server/db/client");
    const run = await tenantTransaction({ tenantId, userId, displayName: "Integration User" }, (db) => db.agentRun.findUniqueOrThrow({
      where: { conversationId_aguiRunId: { conversationId: threadId, aguiRunId: "run-abc" } },
    }));
    expect(run.status).toBe("SUCCEEDED");
    expect(invokeRuntime).toHaveBeenCalledOnce();
  });

  it("cancels the run and persists partial assistant text when the client disconnects", async () => {
    invokeRuntime.mockResolvedValueOnce({
      result: {
        response: { transformToWebStream: hangingRuntimeStream },
        statusCode: 200,
        contentType: "text/event-stream",
      },
    });
    const body = JSON.stringify({
      threadId,
      runId: "run-cancel",
      state: {},
      messages: [{ id: "message-cancel", role: "user", content: "長い回答をください" }],
      tools: [],
      context: [],
      forwardedProps: { inference: { model: "claude-haiku-4-5", reasoning: { enabled: true, effort: "medium" } } },
    });
    const { POST } = await import("@/app/api/runtime/invocations/route");
    const response = await POST(new Request("http://localhost/api/runtime/invocations", { method: "POST", body }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("test disconnect");

    const { tenantTransaction } = await import("@/server/db/client");
    await tenantTransaction({ tenantId, userId, displayName: "Integration User" }, async (db) => {
      const run = await db.agentRun.findUniqueOrThrow({
        where: { conversationId_aguiRunId: { conversationId: threadId, aguiRunId: "run-cancel" } },
      });
      expect(run.status).toBe("CANCELLED");
      expect(run.errorCode).toBe("CLIENT_DISCONNECTED");
      const partial = await db.message.findUniqueOrThrow({
        where: { conversationId_aguiMessageId: { conversationId: threadId, aguiMessageId: "assistant-cancel" } },
      });
      expect(partial.content).toMatchObject({ blocks: [{ text: "途中まで" }] });
    });
  });
});
