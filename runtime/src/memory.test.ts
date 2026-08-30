import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  ListSessionsCommand,
  ResourceNotFoundException,
  RetrieveMemoryRecordsCommand,
  Role,
} from "@aws-sdk/client-bedrock-agentcore";
import { describe, expect, it, vi } from "vitest";
import { AgentCoreMemory } from "./memory.js";

function memoryWith(send: ReturnType<typeof vi.fn>): AgentCoreMemory {
  return new AgentCoreMemory("memory-123", { send } as unknown as BedrockAgentCoreClient);
}

describe("AgentCoreMemory", () => {
  it("records a completed user/assistant turn with an idempotency token", async () => {
    const send = vi.fn().mockResolvedValue({});
    await memoryWith(send).recordTurn("actor-1", "session-1", "run-1", "質問", "回答");

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(CreateEventCommand);
    expect(command.input).toMatchObject({
      memoryId: "memory-123",
      actorId: "actor-1",
      sessionId: "session-1",
      clientToken: "run-1",
      payload: [
        { conversational: { role: Role.USER, content: { text: "質問" } } },
        { conversational: { role: Role.ASSISTANT, content: { text: "回答" } } },
      ],
    });
  });

  it("loads chronological conversational messages and excludes non-conversational payloads", async () => {
    const send = vi.fn().mockResolvedValue({
      events: [
        {
          eventId: "later",
          eventTimestamp: new Date("2026-01-02T00:00:00Z"),
          payload: [{ conversational: { role: Role.ASSISTANT, content: { text: "回答" } } }],
        },
        {
          eventId: "earlier",
          eventTimestamp: new Date("2026-01-01T00:00:00Z"),
          payload: [{ blob: { ignored: true } }, { conversational: { role: Role.USER, content: { text: "質問" } } }],
        },
      ],
    });

    await expect(memoryWith(send).loadMessages("actor-1", "session-1")).resolves.toEqual([
      { id: "earlier-1", role: "user", text: "質問", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "later-0", role: "assistant", text: "回答", createdAt: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListEventsCommand);
  });

  it("lists recent sessions with titles derived from each first user message", async () => {
    const send = vi.fn(async (command: ListSessionsCommand | ListEventsCommand) => {
      if (command instanceof ListSessionsCommand) {
        return { sessionSummaries: [{ sessionId: "session-123456789012345678901234567890", actorId: "actor-1", createdAt: new Date("2026-01-01T00:00:00Z") }] };
      }
      return {
        events: [{
          eventId: "event-1",
          eventTimestamp: new Date("2026-01-01T00:00:00Z"),
          payload: [{ conversational: { role: Role.USER, content: { text: "最初の質問" } } }],
        }],
      };
    });

    await expect(memoryWith(send).listThreads("actor-1")).resolves.toEqual([{
      id: "session-123456789012345678901234567890",
      title: "最初の質問",
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);
  });

  it("treats an actor without any events as an empty thread list", async () => {
    const send = vi.fn().mockRejectedValue(new ResourceNotFoundException({
      $metadata: {},
      message: "Actor actor-1 not found",
    }));

    await expect(memoryWith(send).listThreads("actor-1")).resolves.toEqual([]);
  });

  it("does not hide other resource-not-found failures", async () => {
    const error = new ResourceNotFoundException({
      $metadata: {},
      message: "Memory memory-123 not found",
    });
    const send = vi.fn().mockRejectedValue(error);

    await expect(memoryWith(send).listThreads("actor-1")).rejects.toBe(error);
  });

  it("retrieves user-scoped facts and preferences", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ memoryRecordSummaries: [{ content: { text: "東京都在住" } }] })
      .mockResolvedValueOnce({ memoryRecordSummaries: [{ content: { text: "簡潔な回答を好む" } }] });

    await expect(memoryWith(send).recallPersonalMemory("actor-1", "自己紹介して")).resolves.toEqual([
      "東京都在住",
      "簡潔な回答を好む",
    ]);
    const commands = send.mock.calls.map(([command]) => command);
    expect(commands).toHaveLength(2);
    expect(commands.every((command) => command instanceof RetrieveMemoryRecordsCommand)).toBe(true);
    expect(commands.map((command) => command.input.namespace)).toEqual([
      "/workmate/actor-1/facts",
      "/workmate/actor-1/preferences",
    ]);
  });
});
