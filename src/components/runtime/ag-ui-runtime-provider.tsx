import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  CompositeAttachmentAdapter,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  WebSpeechDictationAdapter,
  WebSpeechSynthesisAdapter,
  useAuiEvent,
  type ExternalStoreThreadData,
  type ThreadMessage,
} from "@assistant-ui/react";
import { useAgUiRuntime, type UseAgUiThreadListAdapter } from "@assistant-ui/react-ag-ui";
import { fetchAuthSession } from "aws-amplify/auth";
import { runtimeInvocationUrl, type RuntimeConfig } from "@/config";
import { DEFAULT_RUNTIME_OPTIONS } from "@/lib/default-runtime-options";
import { debugError, debugLog, isDebugEnabled, parsedRequestBody } from "@/lib/debug";
import { readMemoryResponse } from "@/lib/memory-response";
import { InferenceSettingsProvider } from "./inference-settings";
import { generatedThreadTitle } from "./in-memory-threads";
import { RunErrorAwareHttpAgent } from "./run-error-aware-http-agent";

type RegularThread = ExternalStoreThreadData<"regular">;
type ArchivedThread = ExternalStoreThreadData<"archived">;

async function accessToken(forceRefresh = false): Promise<string> {
  debugLog("auth.access-token.requested", { forceRefresh });
  const session = await fetchAuthSession(forceRefresh ? { forceRefresh: true } : undefined);
  const value = session.tokens?.accessToken?.toString();
  if (!value) throw new Error("認証セッションがありません。再度ログインしてください。");
  debugLog("auth.access-token.available", { forceRefresh, expiresAt: session.tokens?.accessToken?.payload.exp });
  return value;
}

export function authenticatedFetch(threadId: string): typeof fetch {
  return async (input, init) => {
    const send = async (forceRefresh: boolean) => {
      const requestId = crypto.randomUUID();
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      headers.set("Authorization", `Bearer ${await accessToken(forceRefresh)}`);
      headers.set("X-Amzn-Bedrock-AgentCore-Runtime-Session-Id", threadId);
      debugLog("http.request", {
        requestId,
        threadId,
        forceRefresh,
        url: input instanceof Request ? input.url : String(input),
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        accept: headers.get("Accept"),
        contentType: headers.get("Content-Type"),
        body: parsedRequestBody(init?.body),
      });
      const response = await fetch(input, { ...init, headers });
      debugLog("http.response", {
        requestId,
        threadId,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("Content-Type"),
        contentLength: response.headers.get("Content-Length"),
      });
      if (isDebugEnabled()) {
        void response.clone().text()
          .then((body) => debugLog("http.response.body", { requestId, threadId, body }))
          .catch((cause: unknown) => debugError("http.response.body.failed", cause));
      }
      return response;
    };
    let response = await send(false);
    if (response.status === 401 || response.status === 403) {
      debugLog("auth.access-token.retry", { threadId, status: response.status });
      await response.body?.cancel();
      response = await send(true);
    }
    return response;
  };
}

type MemoryThread = { id: string; title: string; createdAt: string };
type MemoryMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseThreads(value: unknown): MemoryThread[] {
  if (!isRecord(value) || !Array.isArray(value.threads)) throw new Error("チャット履歴一覧の応答形式が不正です");
  return value.threads.map((thread) => {
    if (!isRecord(thread) || typeof thread.id !== "string" || typeof thread.title !== "string" || typeof thread.createdAt !== "string") {
      throw new Error("チャット履歴一覧の応答形式が不正です");
    }
    return { id: thread.id, title: thread.title, createdAt: thread.createdAt };
  });
}

function parseMessages(value: unknown): MemoryMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error("チャット履歴の応答形式が不正です");
  return value.messages.map((message) => {
    if (!isRecord(message)
      || typeof message.id !== "string"
      || (message.role !== "user" && message.role !== "assistant")
      || typeof message.text !== "string"
      || typeof message.createdAt !== "string") {
      throw new Error("チャット履歴の応答形式が不正です");
    }
    return { id: message.id, role: message.role, text: message.text, createdAt: message.createdAt };
  });
}

function toThreadMessage(message: MemoryMessage): ThreadMessage {
  const createdAt = new Date(message.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error("チャット履歴の日時が不正です");
  if (message.role === "user") {
    return {
      id: message.id,
      role: "user",
      content: [{ type: "text", text: message.text }],
      attachments: [],
      createdAt,
      metadata: { custom: {} },
    };
  }
  return {
    id: message.id,
    role: "assistant",
    content: [{ type: "text", text: message.text }],
    status: { type: "complete", reason: "stop" },
    createdAt,
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} },
  };
}

async function memoryRequest(config: RuntimeConfig, requestSessionId: string, body: Record<string, string>): Promise<unknown> {
  debugLog("history.request", { requestSessionId, body });
  const response = await authenticatedFetch(requestSessionId)(runtimeInvocationUrl(config), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readMemoryResponse(response);
}

export function AgUiRuntimeProvider({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  const [threadId, setThreadId] = useState<string>(() => crypto.randomUUID());
  const [items, setItems] = useState<Array<RegularThread | ArchivedThread>>([]);
  const [isLoadingThreads, setIsLoadingThreads] = useState(true);
  const historyRequestSessionId = useRef(crypto.randomUUID());
  const runtimeRef = useRef<ReturnType<typeof useAgUiRuntime> | null>(null);
  const regular = items.filter((item): item is RegularThread => item.status === "regular");
  const archived = items.filter((item): item is ArchivedThread => item.status === "archived");
  const replace = useCallback((id: string, update: Partial<RegularThread | ArchivedThread>) => setItems((current) => current.map((item) => item.id === id ? { ...item, ...update } as RegularThread | ArchivedThread : item)), []);
  const showCurrent = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) throw new Error("チャットRuntimeが初期化されていません");
    const title = generatedThreadTitle(runtime.thread.getState().messages) ?? "新しいチャット";
    setItems((current) => {
      const existing = current.find((item) => item.id === threadId);
      if (!existing) return [{ id: threadId, remoteId: threadId, title, status: "regular", custom: { started: true } }, ...current];
      return current.map((item) => item.id === threadId
        ? { ...item, title: item.title === "新しいチャット" ? title : item.title, custom: { ...item.custom, started: true } } as RegularThread | ArchivedThread
        : item);
    });
  }, [threadId]);

  useEffect(() => {
    let active = true;
    void memoryRequest(config, historyRequestSessionId.current, { operation: "memory.listThreads" })
      .then((payload) => {
        if (!active) return;
        setItems(parseThreads(payload).map((thread) => ({
          id: thread.id,
          remoteId: thread.id,
          title: thread.title,
          status: "regular" as const,
          custom: { started: true, createdAt: thread.createdAt },
        })));
      })
      .catch((error: unknown) => {
        debugError("history.list.failed", error);
        if (active) window.dispatchEvent(new CustomEvent("workmate-error", { detail: error instanceof Error ? error.message : String(error) }));
      })
      .finally(() => {
        if (active) setIsLoadingThreads(false);
      });
    return () => { active = false; };
  }, [config]);

  const threadList = useMemo<UseAgUiThreadListAdapter>(() => ({
    threadId,
    isLoading: isLoadingThreads,
    threads: regular,
    archivedThreads: archived,
    onSwitchToNewThread: async () => { setThreadId(crypto.randomUUID()); },
    onSwitchToThread: async (id) => {
      const payload = await memoryRequest(config, historyRequestSessionId.current, { operation: "memory.loadThread", sessionId: id });
      const messages = parseMessages(payload).map(toThreadMessage);
      setThreadId(id);
      return { messages };
    },
    onRename: async (id, title) => replace(id, { title }),
    onUpdateCustom: async (id, custom) => replace(id, { custom }),
    onArchive: async (id) => replace(id, { status: "archived" }),
    onUnarchive: async (id) => replace(id, { status: "regular" }),
    onDelete: async (id) => {
      await memoryRequest(config, historyRequestSessionId.current, { operation: "memory.deleteThread", sessionId: id });
      setItems((current) => current.filter((item) => item.id !== id));
    },
  }), [archived, config, isLoadingThreads, regular, replace, threadId]);

  const agent = useMemo(() => new RunErrorAwareHttpAgent({
    url: runtimeInvocationUrl(config),
    agentId: "workmate",
    threadId,
    headers: { Accept: "text/event-stream" },
    fetch: authenticatedFetch(threadId),
    debug: config.debug ? { events: true, lifecycle: true, verbose: true } : false,
  }), [config, threadId]);
  const logger = useMemo(() => config.debug ? {
    debug: (...values: unknown[]) => debugLog("assistant-ui", values),
    error: (...values: unknown[]) => debugError("assistant-ui", values),
  } : undefined, [config.debug]);
  const attachments = useMemo(() => new CompositeAttachmentAdapter([new SimpleImageAttachmentAdapter(), new SimpleTextAttachmentAdapter()]), []);
  const runtime = useAgUiRuntime({
    agent,
    logger,
    showThinking: true,
    onError: (cause) => {
      debugError("ag-ui.runtime.error", cause);
      window.dispatchEvent(new CustomEvent("workmate-error", { detail: cause.message }));
    },
    adapters: {
      threadList,
      attachments,
      speech: useMemo(() => new WebSpeechSynthesisAdapter(), []),
      dictation: useMemo(() => WebSpeechDictationAdapter.isSupported() ? new WebSpeechDictationAdapter({ language: "ja-JP", continuous: true }) : undefined, []),
      feedback: { submit: ({ type }) => window.dispatchEvent(new CustomEvent("workmate-feedback", { detail: type })) },
    },
  });
  useEffect(() => {
    runtimeRef.current = runtime;
    return () => {
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [runtime]);

  return <AssistantRuntimeProvider runtime={runtime}><InferenceSettingsProvider options={DEFAULT_RUNTIME_OPTIONS}><ThreadLifecycleSync onRunStart={showCurrent} /><Fragment key={threadId}>{children}</Fragment></InferenceSettingsProvider></AssistantRuntimeProvider>;
}

function ThreadLifecycleSync({ onRunStart }: { onRunStart: () => void }) {
  useAuiEvent("thread.runStart", onRunStart);
  return null;
}
