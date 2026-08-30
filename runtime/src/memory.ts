import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  DeleteEventCommand,
  ListEventsCommand,
  ListSessionsCommand,
  ResourceNotFoundException,
  RetrieveMemoryRecordsCommand,
  Role,
  type Event,
} from "@aws-sdk/client-bedrock-agentcore";
import type { MessageData } from "@strands-agents/sdk";

export type StoredChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

export type StoredChatThread = {
  id: string;
  title: string;
  createdAt: string;
};

const titleLength = 40;

function isMissingActor(error: unknown): boolean {
  return error instanceof ResourceNotFoundException && /^Actor .+ not found$/u.test(error.message);
}

function conversationalMessages(events: readonly Event[]): StoredChatMessage[] {
  return events.flatMap((event) => (event.payload ?? []).flatMap((payload, index) => {
    if (!("conversational" in payload) || !payload.conversational) return [];
    const { content, role } = payload.conversational;
    if (!content || !("text" in content) || !content.text || (role !== Role.USER && role !== Role.ASSISTANT)) return [];
    return [{
      id: `${event.eventId ?? "event"}-${index}`,
      role: role === Role.USER ? "user" as const : "assistant" as const,
      text: content.text,
      createdAt: (event.eventTimestamp ?? new Date(0)).toISOString(),
    }];
  }));
}

function threadTitle(messages: readonly StoredChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user")?.text.trim();
  if (!firstUserMessage) return "新しいチャット";
  return firstUserMessage.length > titleLength ? `${firstUserMessage.slice(0, titleLength)}…` : firstUserMessage;
}

export class AgentCoreMemory {
  constructor(
    private readonly memoryId: string,
    private readonly client: BedrockAgentCoreClient,
  ) {}

  static create(memoryId: string, region: string): AgentCoreMemory {
    return new AgentCoreMemory(memoryId, new BedrockAgentCoreClient({ region }));
  }

  async recordTurn(actorId: string, sessionId: string, runId: string, userText: string, assistantText: string): Promise<void> {
    await this.client.send(new CreateEventCommand({
      memoryId: this.memoryId,
      actorId,
      sessionId,
      eventTimestamp: new Date(),
      clientToken: runId,
      payload: [
        { conversational: { role: Role.USER, content: { text: userText } } },
        { conversational: { role: Role.ASSISTANT, content: { text: assistantText } } },
      ],
    }));
  }

  async loadMessages(actorId: string, sessionId: string): Promise<StoredChatMessage[]> {
    return conversationalMessages(await this.listEvents(actorId, sessionId));
  }

  async loadModelHistory(actorId: string, sessionId: string): Promise<MessageData[]> {
    return (await this.loadMessages(actorId, sessionId)).map((message) => ({
      role: message.role,
      content: [{ text: message.text }],
    }));
  }

  async listThreads(actorId: string): Promise<StoredChatThread[]> {
    const sessions = [];
    let nextToken: string | undefined;
    try {
      do {
        const page = await this.client.send(new ListSessionsCommand({
          memoryId: this.memoryId,
          actorId,
          maxResults: 100,
          nextToken,
        }));
        sessions.push(...(page.sessionSummaries ?? []));
        if (page.nextToken === nextToken && page.nextToken !== undefined) throw new Error("AgentCore Memory returned a repeated session page token");
        nextToken = page.nextToken;
      } while (nextToken);
    } catch (error) {
      // AgentCore Memoryは最初のイベントが保存されるまでActorを作らない。
      if (isMissingActor(error)) return [];
      throw error;
    }

    const recentSessions = sessions
      .filter((session): session is typeof session & { sessionId: string; createdAt: Date } => Boolean(session.sessionId && session.createdAt))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, 50);
    return Promise.all(recentSessions.map(async (session) => ({
      id: session.sessionId,
      title: threadTitle(await this.loadMessages(actorId, session.sessionId)),
      createdAt: session.createdAt.toISOString(),
    })));
  }

  async deleteThread(actorId: string, sessionId: string): Promise<void> {
    const events = await this.listEvents(actorId, sessionId);
    await Promise.all(events.map(async (event) => {
      if (!event.eventId) throw new Error("AgentCore Memory event is missing eventId");
      await this.client.send(new DeleteEventCommand({
        memoryId: this.memoryId,
        actorId,
        sessionId,
        eventId: event.eventId,
      }));
    }));
  }

  async recallPersonalMemory(actorId: string, query: string): Promise<string[]> {
    const namespaces = [`/workmate/${actorId}/facts`, `/workmate/${actorId}/preferences`];
    const pages = await Promise.all(namespaces.map((namespace) => this.client.send(new RetrieveMemoryRecordsCommand({
      memoryId: this.memoryId,
      namespace,
      searchCriteria: { searchQuery: query, topK: 5 },
      maxResults: 5,
    }))));
    return pages.flatMap((page) => (page.memoryRecordSummaries ?? []).flatMap((record) => {
      const content = record.content;
      return content && "text" in content && content.text ? [content.text] : [];
    }));
  }

  private async listEvents(actorId: string, sessionId: string): Promise<Event[]> {
    const events: Event[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(new ListEventsCommand({
        memoryId: this.memoryId,
        actorId,
        sessionId,
        includePayloads: true,
        maxResults: 100,
        nextToken,
      }));
      events.push(...(page.events ?? []));
      if (page.nextToken === nextToken && page.nextToken !== undefined) throw new Error("AgentCore Memory returned a repeated event page token");
      nextToken = page.nextToken;
    } while (nextToken);
    return events.sort((left, right) => (left.eventTimestamp?.getTime() ?? 0) - (right.eventTimestamp?.getTime() ?? 0));
  }
}
