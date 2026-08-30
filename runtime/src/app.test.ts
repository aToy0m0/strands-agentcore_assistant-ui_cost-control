import { EventType, type RunAgentInput } from "@ag-ui/core";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, type InvocationIdentity } from "./app.js";

const input = {
  threadId: "0198d773-8f67-7678-baba-668a48c4d76f",
  runId: "0198d773-8f67-7678-baba-668a48c4d770",
  state: {},
  messages: [
    {
      id: "0198d773-8f67-7678-baba-668a48c4d771",
      role: "user",
      content: "1 + 2 は？",
    },
  ],
  tools: [],
  context: [],
  forwardedProps: { inference: { model: "claude-haiku-4-5", reasoning: { enabled: true, effort: "medium" } } },
};
const authorization = `Bearer header.${Buffer.from(JSON.stringify({ sub: "user-123" })).toString("base64url")}.signature`;
const profiledAuthorization = `Bearer header.${Buffer.from(JSON.stringify({ sub: "user-123", "cognito:groups": ["workmate-limit-daily"] })).toString("base64url")}.signature`;

function eventsFrom(text: string): Array<Record<string, unknown>> {
  return text.split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe("AgentCore HTTP contract", () => {
  it("returns the ping response", async () => {
    await request(createApp(vi.fn())).get("/ping").expect(200, { status: "Healthy" });
  });

  it("rejects invalid AG-UI input before invoking the agent", async () => {
    const invokeAgent = vi.fn();
    await request(createApp(invokeAgent)).post("/invocations").set("Authorization", authorization).send({}).expect(400);
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it("rejects an invocation without the verified token forwarded by AgentCore", async () => {
    await request(createApp(vi.fn())).post("/invocations").send(input).expect(401);
  });

  it("streams the AG-UI lifecycle", async () => {
    const invokeAgent = vi.fn(async function* (_input: RunAgentInput, _cancelSignal: AbortSignal, _identity: InvocationIdentity) {
      void _input;
      void _cancelSignal;
      void _identity;
      yield { type: "reasoning" as const, text: "計算方法を確認しています。\n" };
      yield { type: "reasoning-end" as const };
      yield { type: "text" as const, text: "3" };
      yield { type: "text" as const, text: "です。" };
    });
    const response = await request(createApp(invokeAgent))
      .post("/invocations")
      .set("Authorization", authorization)
      .set("Accept", "text/event-stream")
      .send(input)
      .expect(200)
      .expect("Content-Type", /text\/event-stream/);

    expect(invokeAgent).toHaveBeenCalledOnce();
    expect(invokeAgent.mock.calls[0]?.[0]).toMatchObject(input);
    expect(invokeAgent.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(invokeAgent.mock.calls[0]?.[2]).toEqual({ actorId: "user-123", authorization });
    expect(response.text).toContain(EventType.RUN_STARTED);
    expect(response.text).toContain(EventType.REASONING_START);
    expect(response.text).toContain(EventType.REASONING_MESSAGE_START);
    expect(response.text).toContain(EventType.REASONING_MESSAGE_CONTENT);
    expect(response.text).toContain(EventType.REASONING_MESSAGE_END);
    expect(response.text).toContain(EventType.REASONING_END);
    expect(response.text).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(response.text.indexOf(EventType.REASONING_END)).toBeLessThan(response.text.indexOf(EventType.TEXT_MESSAGE_START));
    expect(response.text).toContain('"delta":"3"');
    expect(response.text).toContain('"delta":"です。"');
    expect(response.text).toContain(EventType.RUN_FINISHED);
  });

  it("Cognitoグループのユーザー上限プロファイルを実行IDへ渡す", async () => {
    const invokeAgent = vi.fn(async function* (_input: RunAgentInput, _cancelSignal: AbortSignal, _identity: InvocationIdentity) {
      yield { type: "text" as const, text: "ok" };
    });
    await request(createApp(invokeAgent)).post("/invocations").set("Authorization", profiledAuthorization).send(input).expect(200);
    expect(invokeAgent.mock.calls[0]?.[2]).toEqual({ actorId: "user-123", authorization: profiledAuthorization, limitProfileId: "daily" });
  });

  it("returns RUN_ERROR in the stream when agent invocation fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await request(createApp(async function* () {
      throw new Error("Bedrock unavailable: secret model details");
    }))
      .post("/invocations")
      .set("Authorization", authorization)
      .set("Accept", "text/event-stream")
      .send(input)
      .expect(200);

    expect(response.text).toContain(EventType.RUN_ERROR);
    expect(response.text).toContain("AGENT_INVOCATION_FAILED");
    expect(response.text).toContain("エージェントの実行に失敗しました");
    expect(response.text).not.toContain("secret model details");
    consoleError.mockRestore();
  });

  it("closes an open reasoning message before RUN_ERROR", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await request(createApp(async function* () {
      yield { type: "reasoning" as const, text: "確認しています。\n" };
      throw new Error("Bedrock unavailable");
    }))
      .post("/invocations")
      .set("Authorization", authorization)
      .set("Accept", "text/event-stream")
      .send(input)
      .expect(200);

    expect(response.text).toContain(EventType.REASONING_MESSAGE_END);
    expect(response.text).toContain(EventType.REASONING_END);
    expect(response.text.indexOf(EventType.REASONING_END)).toBeLessThan(response.text.indexOf(EventType.RUN_ERROR));
    consoleError.mockRestore();
  });

  it("pairs and uniquely identifies alternating reasoning and text sections", async () => {
    const response = await request(createApp(async function* () {
      yield { type: "reasoning" as const, text: "確認1\n" };
      yield { type: "text" as const, text: "回答1" };
      yield { type: "reasoning" as const, text: "確認2\n" };
      yield { type: "text" as const, text: "回答2" };
    }))
      .post("/invocations")
      .set("Authorization", authorization)
      .set("Accept", "text/event-stream")
      .send(input)
      .expect(200);

    const events = eventsFrom(response.text);
    const count = (type: EventType) => events.filter((event) => event.type === type).length;
    expect(count(EventType.REASONING_START)).toBe(2);
    expect(count(EventType.REASONING_END)).toBe(2);
    expect(count(EventType.TEXT_MESSAGE_START)).toBe(2);
    expect(count(EventType.TEXT_MESSAGE_END)).toBe(2);
    const reasoningIds = events
      .filter((event) => event.type === EventType.REASONING_START
        || event.type === EventType.REASONING_MESSAGE_START)
      .map((event) => event.messageId);
    expect(new Set(reasoningIds).size).toBe(reasoningIds.length);
    const textIds = events.filter((event) => event.type === EventType.TEXT_MESSAGE_START).map((event) => event.messageId);
    expect(new Set(textIds).size).toBe(textIds.length);
  });

  it("keeps tool calls between the text sections that surround them", async () => {
    const response = await request(createApp(async function* () {
      yield { type: "text" as const, text: "3つ同時に動かしてみます！" };
      yield { type: "tool-start" as const, id: "tool-1", name: "calculator", input: { expression: "1+2" } };
      yield { type: "tool-result" as const, id: "tool-1", result: { value: 3 } };
      yield { type: "text" as const, text: "結果はこちら！" };
    }))
      .post("/invocations")
      .set("Authorization", authorization)
      .set("Accept", "text/event-stream")
      .send(input)
      .expect(200);

    const events = eventsFrom(response.text);
    const textStarts = events.filter((event) => event.type === EventType.TEXT_MESSAGE_START);
    expect(textStarts).toHaveLength(2);
    expect(textStarts[0]?.messageId).not.toBe(textStarts[1]?.messageId);
    // 先行するテキストを親にすることで、クライアントはそのテキストの直後へツールを挿入する。
    expect(events.find((event) => event.type === EventType.TOOL_CALL_START)?.parentMessageId)
      .toBe(textStarts[0]?.messageId);
  });

  it("emits separate AG-UI reasoning messages for consecutive reasoning blocks", async () => {
    const response = await request(createApp(async function* () {
      yield { type: "reasoning" as const, text: "仮説を立てます。" };
      yield { type: "reasoning-end" as const };
      yield { type: "reasoning" as const, text: "仮説を検証します。" };
      yield { type: "reasoning-end" as const };
      yield { type: "text" as const, text: "結論です。" };
    }))
      .post("/invocations")
      .set("Authorization", authorization)
      .set("Accept", "text/event-stream")
      .send(input)
      .expect(200);

    const events = eventsFrom(response.text);
    expect(events.filter((event) => event.type === EventType.REASONING_START)).toHaveLength(2);
    expect(events.filter((event) => event.type === EventType.REASONING_MESSAGE_START)).toHaveLength(2);
    expect(events.filter((event) => event.type === EventType.REASONING_END)).toHaveLength(2);
  });

  it("links tool calls and the final text to one assistant message", async () => {
    const response = await request(createApp(async function* () {
      yield { type: "tool-start" as const, id: "tool-1", name: "calculator", input: { expression: "1+2" } };
      yield { type: "tool-result" as const, id: "tool-1", result: { value: 3 } };
      yield { type: "text" as const, text: "3です。" };
    }))
      .post("/invocations")
      .set("Authorization", authorization)
      .set("Accept", "text/event-stream")
      .send(input)
      .expect(200);

    const events = eventsFrom(response.text);
    const start = events.find((event) => event.type === EventType.TOOL_CALL_START);
    const text = events.find((event) => event.type === EventType.TEXT_MESSAGE_START);
    expect(start?.parentMessageId).toBe(text?.messageId);
    expect(events.find((event) => event.type === EventType.TOOL_CALL_ARGS)?.delta).toBe('{"expression":"1+2"}');
    expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)?.content).toBe('{"result":{"value":3}}');
  });

  it("finishes with an interrupt outcome without requiring assistant text", async () => {
    const response = await request(createApp(async function* () {
      yield { type: "tool-start" as const, id: "tool-ask", name: "ask_user", input: { question: "対象は？" } };
      yield { type: "interrupt" as const, interrupts: [{ id: "interrupt-1", reason: "input_required", message: "対象は？" }] };
    }))
      .post("/invocations")
      .set("Authorization", authorization)
      .set("Accept", "text/event-stream")
      .send(input)
      .expect(200);

    const events = eventsFrom(response.text);
    expect(events.find((event) => event.type === EventType.RUN_FINISHED)?.outcome).toEqual({
      type: "interrupt",
      interrupts: [{ id: "interrupt-1", reason: "input_required", message: "対象は？" }],
    });
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
  });
});
