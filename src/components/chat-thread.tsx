"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { useAgUiInterrupts, useAgUiSubmitInterruptResponses } from "@assistant-ui/react-ag-ui";
import {
  ArrowDown, ArrowUp, AudioWaveform, ChevronDown, ChevronLeft, ChevronRight,
  Camera, Copy, File as FileIcon, FileUp, FolderKanban, Image as ImageIcon, Pencil, Plus,
  Check, LoaderCircle, Square, ThumbsDown, ThumbsUp, X,
} from "lucide-react";
import { toast } from "sonner";
import type { AgentProfile } from "@/lib/agents";
import type { Project } from "./conversation-sidebar";
import { cn } from "@/lib/utils";
import { MarkdownText } from "./markdown-text";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { useInferenceSettings } from "./runtime/inference-settings";
import type { ReasoningEffort } from "@/lib/runtime-options";

const iconButton = "grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ChatThread({ agent, selectedProject, onClearSelectedProject }: { agent: AgentProfile; selectedProject?: Project; onClearSelectedProject: () => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const messageCount = useAuiState((state) => state.thread.messages.length);
  const [hasScrollableOverflow, setHasScrollableOverflow] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setHasScrollableOverflow(viewport.scrollHeight - viewport.clientHeight > 80);
    update();
    const resizeObserver = new ResizeObserver(update);
    const mutationObserver = new MutationObserver(update);
    resizeObserver.observe(viewport);
    mutationObserver.observe(viewport, { childList: true, subtree: true, characterData: true });
    viewport.addEventListener("scroll", update, { passive: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      viewport.removeEventListener("scroll", update);
    };
  }, [messageCount]);

  return (
    <ThreadPrimitive.Root role="region" className="relative flex min-h-0 flex-1 flex-col" aria-label={`${agent.name}との会話`}>
      <AuiIf condition={(state) => state.thread.messages.length === 0}><Welcome selectedProject={selectedProject} onClearSelectedProject={onClearSelectedProject} /></AuiIf>
      <AuiIf condition={(state) => state.thread.messages.length > 0}>
        <ThreadPrimitive.Viewport ref={viewportRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4" turnAnchor="top">
          <div className="mx-auto w-full max-w-3xl flex-1 py-8">
            <ThreadPrimitive.Messages>
              {({ message }) => message.composer.isEditing ? <EditComposer /> : message.role === "user" ? <UserMessage /> : <AssistantMessage />}
            </ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto w-full max-w-3xl bg-gradient-to-t from-background via-background via-80% to-transparent pb-3 pt-8">
            {hasScrollableOverflow && <ThreadPrimitive.ScrollToBottom className="absolute -top-2 left-1/2 grid size-9 -translate-x-1/2 place-items-center rounded-full border bg-background shadow-md" aria-label="一番下へ移動"><ArrowDown className="size-4" /></ThreadPrimitive.ScrollToBottom>}
            <FollowupSuggestions />
            <Composer placeholder="メッセージ" />
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </AuiIf>
    </ThreadPrimitive.Root>
  );
}

function Welcome({ selectedProject, onClearSelectedProject }: { selectedProject?: Project; onClearSelectedProject: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto px-4">
      <div className="mx-auto flex w-full max-w-[690px] flex-col justify-center py-16 sm:py-24 lg:py-32">
        <div className="mb-7 text-center">
          <h1 className="text-2xl font-normal tracking-tight sm:text-[28px]">お手伝いできることはありますか？</h1>
        </div>
        <Composer placeholder="AIエージェントに質問" elevated />
        {selectedProject && <div className="mx-auto mt-4 flex items-center gap-2 rounded-xl border bg-muted/35 px-3 py-2 text-xs" aria-label={`登録先プロジェクト: ${selectedProject.name}`}><FolderKanban className="size-4" style={{ color: selectedProject.color }} /><strong>{selectedProject.name}</strong><Button type="button" variant="ghost" size="icon" className="-mr-1 size-6" aria-label="登録先プロジェクトを解除" onClick={onClearSelectedProject}><X className="size-3.5" /></Button></div>}
      </div>
    </div>
  );
}

function Composer({ placeholder, elevated = false }: { placeholder: string; elevated?: boolean }) {
  const api = useAui();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  async function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    try {
      for (const file of files) await api.composer.addAttachment(file);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ファイルを添付できませんでした");
    }
  }

  function openFilePicker(ref: { current: HTMLInputElement | null }) {
    setAttachmentMenuOpen(false);
    ref.current?.click();
  }

  async function addCameraPhoto(file: File) {
    try {
      await api.composer.addAttachment(file);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "撮影した写真を添付できませんでした");
      throw error;
    }
  }

  async function startVoiceInput() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("このブラウザはマイク入力に対応していません");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      api.composer.startDictation();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        toast.error("マイクの利用が許可されていません。ブラウザのサイト設定を確認してください");
        return;
      }
      toast.error(error instanceof Error ? error.message : "音声入力を開始できませんでした");
    }
  }

  return (
    <>
    <div>
      <ComposerPrimitive.Root data-testid="composer" className={cn("rounded-[26px] border bg-background p-1.5 transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15", elevated && "shadow-[0_10px_35px_rgb(0_0_0/0.1)]")}>
        <AuiIf condition={(state) => state.composer.attachments.length > 0}>
          <div className="px-2 pt-2"><ComposerPrimitive.Attachments>{() => <AttachmentCard removable />}</ComposerPrimitive.Attachments></div>
        </AuiIf>
        <div className="flex min-h-12 w-full items-end gap-1">
          <ComposerPrimitive.Input rows={1} placeholder={placeholder} className="max-h-36 min-h-12 min-w-0 flex-1 resize-none bg-transparent px-3 py-3 text-[15px] outline-none placeholder:text-muted-foreground" aria-label="メッセージ" />
          <AuiIf condition={(state) => state.thread.isRunning}><ComposerPrimitive.Cancel className="mb-1 grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground" aria-label="生成を停止"><Square className="size-3.5" fill="currentColor" /></ComposerPrimitive.Cancel></AuiIf>
          <AuiIf condition={(state) => !state.thread.isRunning && state.composer.dictation != null}><ComposerPrimitive.StopDictation className="mb-1 grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground" aria-label="音声入力を停止"><Square className="size-3.5" fill="currentColor" /></ComposerPrimitive.StopDictation></AuiIf>
          <AuiIf condition={(state) => !state.thread.isRunning && state.composer.dictation == null && !state.composer.isEmpty}><ComposerPrimitive.Send className="mb-1 grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground" aria-label="送信"><ArrowUp className="size-5" /></ComposerPrimitive.Send></AuiIf>
          <AuiIf condition={(state) => state.thread.capabilities.dictation && !state.thread.isRunning && state.composer.dictation == null && state.composer.isEmpty}><button type="button" className="mb-1 grid size-9 shrink-0 place-items-center rounded-full bg-amber-400 text-white" aria-label="音声で入力" onClick={() => void startVoiceInput()}><AudioWaveform className="size-4" /></button></AuiIf>
        </div>
      </ComposerPrimitive.Root>
      <div className="grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2 pt-1.5">
        <p className="text-left text-[11px] leading-4 text-muted-foreground">AIの回答には誤りが含まれる場合があります。重要な情報は確認してください。</p>
        <div className="flex shrink-0 items-center justify-end gap-1">
          <InferenceControls />
        <Popover open={attachmentMenuOpen} onOpenChange={setAttachmentMenuOpen}>
          <PopoverTrigger asChild><button type="button" className={iconButton} aria-label="添付メニューを開く"><Plus className="size-5" /></button></PopoverTrigger>
          <PopoverContent align="start" side="top" className="w-56 p-1.5">
            <button type="button" className="flex min-h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-accent" onClick={() => openFilePicker(fileInputRef)}><FileUp className="size-4" />ファイルをアップロード</button>
            <button type="button" className="flex min-h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-accent" onClick={() => { setAttachmentMenuOpen(false); setCameraOpen(true); }}><Camera className="size-4" />写真を撮影</button>
            <button type="button" className="flex min-h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-accent md:hidden" onClick={() => openFilePicker(photoInputRef)}><ImageIcon className="size-4" />写真を選択</button>
          </PopoverContent>
        </Popover>
        <input ref={fileInputRef} type="file" accept="image/*,text/*" multiple className="hidden" aria-label="ファイルをアップロード" onChange={(event) => void addFiles(event)} />
        <input ref={photoInputRef} type="file" accept="image/*" multiple className="hidden" aria-label="写真を選択" onChange={(event) => void addFiles(event)} />
        </div>
      </div>
    </div>
    {cameraOpen && <CameraCaptureDialog onClose={() => setCameraOpen(false)} onCapture={addCameraPhoto} />}
    </>
  );
}

function CameraCaptureDialog({ onClose, onCapture }: { onClose: () => void; onCapture: (file: File) => Promise<void> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;

    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("このブラウザはカメラ撮影に対応していません。");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (!videoRef.current) throw new Error("カメラ映像の表示先を初期化できませんでした。");
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setReady(true);
      } catch (cameraError) {
        const message = cameraError instanceof DOMException && cameraError.name === "NotAllowedError"
          ? "カメラの利用が許可されていません。ブラウザのサイト設定を確認してください。"
          : cameraError instanceof Error ? cameraError.message : "カメラを起動できませんでした。";
        setError(message);
      }
    }

    void startCamera();
    return () => {
      disposed = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  async function capture() {
    const video = videoRef.current;
    if (!video || !ready || video.videoWidth === 0 || video.videoHeight === 0) {
      setError("カメラ映像の準備が完了していません。");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("撮影画像を生成できませんでした。");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("撮影画像をJPEGへ変換できませんでした。")), "image/jpeg", 0.92));
    await onCapture(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
    onClose();
  }

  return <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}><DialogContent className="max-w-2xl"><DialogTitle>写真を撮影</DialogTitle><DialogDescription>カメラ映像を確認して撮影してください。</DialogDescription><div className="mt-3 overflow-hidden rounded-xl bg-black"><video ref={videoRef} className="aspect-video w-full object-cover" autoPlay muted playsInline aria-label="カメラ映像" /></div>{error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>キャンセル</Button><Button type="button" disabled={!ready || error !== undefined} onClick={() => void capture()}><Camera className="size-4" />撮影して添付</Button></div></DialogContent></Dialog>;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="group mb-8 flex flex-col items-end">
      <MessagePrimitive.Attachments>{() => <AttachmentCard />}</MessagePrimitive.Attachments>
      <div data-testid="user-bubble" className="max-w-[85%] rounded-3xl bg-secondary px-4 py-2.5 text-[15px] [&_.aui-md>p]:m-0"><MessagePrimitive.Parts /></div>
      <ActionBarPrimitive.Root className="mt-1 flex opacity-0 transition-opacity group-hover:opacity-100" autohide="always" hideWhenRunning>
        <ActionBarPrimitive.Copy className={iconButton} aria-label="コピー"><Copy className="size-4" /></ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Edit className={iconButton} aria-label="編集"><Pencil className="size-4" /></ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>
      <BranchPicker />
    </MessagePrimitive.Root>
  );
}

function EditComposer() {
  return (
    <ComposerPrimitive.Root className="mb-8 w-full rounded-2xl border bg-background p-3 shadow-sm">
      <ComposerPrimitive.Input className="min-h-24 w-full resize-none bg-transparent p-2 outline-none" aria-label="メッセージを編集" />
      <div className="mt-2 flex justify-end gap-2"><ComposerPrimitive.Cancel className="rounded-lg border px-3 py-2 text-sm">キャンセル</ComposerPrimitive.Cancel><ComposerPrimitive.Send className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">送信</ComposerPrimitive.Send></div>
    </ComposerPrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root data-testid="assistant-message" className="group mb-10">
      <div className="text-[15px]">
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-thinking"],
            "tool-call": ["group-thinking"],
            "standalone-tool-call": [],
          })}
          indicator="never"
        >
          {({ part, children }) => {
            if (part.type === "group-thinking") return <ThinkingAccordion running={part.status.type === "running"}>{children}</ThinkingAccordion>;
            if (part.type === "text") return <MarkdownText />;
            if (part.type === "reasoning") return <ReasoningCard text={part.text} running={part.status.type === "running"} />;
            if (part.type === "tool-call") return <ToolCard toolName={part.toolName} args={part.args} result={part.result} isError={part.isError} status={part.status.type} />;
            if (part.type === "image") return <img className="my-3 max-w-full rounded-xl border" src={part.image} alt={part.filename ?? "生成画像"} />;
            return null;
          }}
        </MessagePrimitive.GroupedParts>
        <AskUserPrompt />
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <ErrorPrimitive.Message />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
      <div className="mt-2 flex items-center">
        <ActionBarPrimitive.Root className="flex" hideWhenRunning>
          <ActionBarPrimitive.Copy className={iconButton} aria-label="コピー"><Copy className="size-4" /></ActionBarPrimitive.Copy>
          <ActionBarPrimitive.FeedbackPositive className={iconButton} aria-label="良い回答"><ThumbsUp className="size-4" /></ActionBarPrimitive.FeedbackPositive>
          <ActionBarPrimitive.FeedbackNegative className={iconButton} aria-label="改善が必要"><ThumbsDown className="size-4" /></ActionBarPrimitive.FeedbackNegative>
        </ActionBarPrimitive.Root>
        <BranchPicker />
      </div>
    </MessagePrimitive.Root>
  );
}

function AskUserPrompt() {
  const interrupts = useAgUiInterrupts();
  const submitResponses = useAgUiSubmitInterruptResponses();
  const requiresInput = useAuiState((state) => state.message.status?.type === "requires-action" && state.message.status.reason === "interrupt");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const pending = requiresInput ? interrupts : [];
  if (pending.length === 0) return null;

  const canSubmit = pending.every((item) => answers[item.id]?.trim());
  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      await submitResponses(pending.map((item) => ({
        interruptId: item.id,
        status: "resolved" as const,
        payload: answers[item.id]!.trim(),
      })));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "回答を送信できませんでした";
      window.dispatchEvent(new CustomEvent("workmate-error", { detail: message }));
      setSubmitting(false);
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  return (
    <form className="my-3 space-y-4 rounded-xl border border-agent/30 bg-agent/5 p-4" onSubmit={onSubmit}>
      {pending.map((interrupt) => {
        const metadata = interrupt.metadata ?? {};
        const options = Array.isArray(metadata.options) ? metadata.options.filter((option): option is string => typeof option === "string") : [];
        const allowFreeText = metadata.allowFreeText !== false;
        return <fieldset key={interrupt.id} disabled={submitting}><legend className="font-medium">{interrupt.message ?? "確認させてください。"}</legend>{options.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{options.map((option) => <Button key={option} type="button" variant={answers[interrupt.id] === option ? "default" : "outline"} onClick={() => setAnswers((current) => ({ ...current, [interrupt.id]: option }))}>{option}</Button>)}</div>}{allowFreeText && <input className="mt-3 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={answers[interrupt.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [interrupt.id]: event.target.value }))} aria-label="質問への回答" placeholder="回答を入力" />}</fieldset>;
      })}
      <Button type="submit" disabled={!canSubmit || submitting}>{submitting ? "送信中…" : "回答して続ける"}</Button>
    </form>
  );
}

function BranchPicker() {
  return (
    <BranchPickerPrimitive.Root hideWhenSingleBranch className="ml-1 flex items-center gap-1 text-xs text-muted-foreground">
      <BranchPickerPrimitive.Previous className={iconButton} aria-label="前の回答"><ChevronLeft className="size-4" /></BranchPickerPrimitive.Previous>
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      <BranchPickerPrimitive.Next className={iconButton} aria-label="次の回答"><ChevronRight className="size-4" /></BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}

/** 回答が完了した時点で思考の折りたたみを閉じる。完了後に利用者が開き直した場合は開いたままにする。 */
function useCollapseOnMessageComplete(setOpen: (open: boolean) => void) {
  const messageRunning = useAuiState((state) => state.message.status?.type === "running");
  useEffect(() => {
    if (!messageRunning) setOpen(false);
  }, [messageRunning, setOpen]);
}

function ThinkingAccordion({ running, children }: { running: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(running);
  useCollapseOnMessageComplete(setOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-3 overflow-hidden rounded-xl border bg-muted/30" data-testid="thinking-accordion">
      <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        {running && <LoaderCircle className="size-4 animate-spin text-agent motion-reduce:animate-none" aria-hidden="true" />}
        <span>{running ? "処理中" : "処理の概要"}</span>
        <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent aria-live="polite" aria-atomic="false" data-testid="thinking-content" className="border-t px-3 py-2.5">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Reasoning({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{text.trimEnd()}</p>;
}

function ReasoningCard({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState(running);
  useCollapseOnMessageComplete(setOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-1" data-testid="reasoning-card">
      <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 rounded-md px-1 text-left text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {running && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        <span>内容を考えています。</span>
        <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent aria-busy={running} className="ml-1 mt-1 rounded-lg border bg-card p-3">
        <Reasoning text={text} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function formattedJson(value: unknown): string {
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

function toolResultDetails(result: unknown, isError?: boolean): { output?: unknown; error?: unknown } {
  let decoded = result;
  if (typeof result === "string") {
    try { decoded = JSON.parse(result) as unknown; } catch { return isError ? { error: result } : { output: result }; }
  }
  if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
    const value = decoded as Record<string, unknown>;
    if (Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) {
      return { output: value.result, error: value.error };
    }
  }
  return isError ? { error: decoded } : { output: decoded };
}

function ToolCard({ toolName, args, result, isError, status }: { toolName: string; args: unknown; result?: unknown; isError?: boolean; status: string }) {
  const [open, setOpen] = useState(false);
  const details = result === undefined ? {} : toolResultDetails(result, isError);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-1" data-testid="tool-card">
      <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 rounded-md px-1 text-left text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {status === "running" && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        <span>ツールを実行しています。</span>
        <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-1 mt-1 space-y-3 rounded-lg border bg-card p-3 text-xs">
        <div><strong className="text-foreground">ツール名</strong><p className="mt-1 font-mono text-muted-foreground">{toolName}</p></div>
        <TraceJson label="入力" value={args} />
        {details.output !== undefined && <TraceJson label="出力" value={details.output} />}
        {details.error !== undefined && <TraceJson label="エラー" value={details.error} error />}
      </CollapsibleContent>
    </Collapsible>
  );
}

function TraceJson({ label, value, error = false }: { label: string; value: unknown; error?: boolean }) {
  return <div><strong className={error ? "text-destructive" : "text-foreground"}>{label}</strong><pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono leading-5 text-muted-foreground">{formattedJson(value)}</pre></div>;
}

const effortLabels: Record<ReasoningEffort, string> = { low: "Low", medium: "Medium", high: "High" };

function InferenceControls() {
  const { options, selection, selectedModel, selectModel, setReasoningEnabled, setEffort } = useInferenceSettings();
  const running = useAuiState((state) => state.thread.isRunning);
  const [open, setOpen] = useState(false);
  const enabled = selection.reasoning.enabled;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={running} aria-label="モデルとReasoningを設定" className="flex h-8 max-w-40 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-sm:max-w-28">
          <span className="truncate">{selectedModel.label}</span><ChevronDown className="size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" collisionPadding={12} className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(360px,calc(100vw-24px))] flex-col overflow-hidden p-1.5">
        <div role="listbox" aria-label="モデル" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {options.models.map((model) => (
            <button key={model.id} type="button" role="option" aria-selected={model.id === selectedModel.id} className="relative flex min-h-14 w-full flex-col justify-center rounded-lg px-3 pr-9 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => selectModel(model.id)}>
              <span className="text-sm font-medium">{model.label}</span>
              {model.id === selectedModel.id && <Check className="absolute right-3 top-1/2 size-4 -translate-y-1/2" aria-hidden="true" />}
            </button>
          ))}
        </div>
        <div className="mt-1 shrink-0 border-t px-2 py-2">
          <div className="flex items-center justify-between gap-3">
            <span><strong className="block text-xs">Reasoning</strong>{selectedModel.reasoning.control === "always-on" && <small className="text-[10px] text-muted-foreground">停止不可・OFF時はLow</small>}</span>
            <Switch checked={enabled} onCheckedChange={setReasoningEnabled} aria-label="Reasoningを切り替える" />
          </div>
          {enabled && selectedModel.reasoning.efforts.length > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs font-medium">Effort</span>
              <div role="group" aria-label="Reasoning effort" className="flex rounded-lg bg-muted p-0.5">
                {selectedModel.reasoning.efforts.map((effort) => <button key={effort} type="button" aria-pressed={selection.reasoning.enabled && selection.reasoning.effort === effort} onClick={() => setEffort(effort)} className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm">{effortLabels[effort]}</button>)}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AttachmentCard({ removable = false }: { removable?: boolean }) {
  return (
    <AttachmentPrimitive.Root className="m-1 flex max-w-64 items-center gap-2 rounded-xl border bg-card p-2 text-xs">
      <span className="grid size-8 place-items-center rounded-lg bg-muted"><FileIcon className="size-4" /></span>
      <span className="min-w-0 flex-1"><strong className="block truncate font-medium"><AttachmentPrimitive.Name /></strong><small className="text-muted-foreground">{removable ? "送信前" : "添付ファイル"}</small></span>
      {removable && <AttachmentPrimitive.Remove className={iconButton} aria-label="添付を削除"><X className="size-4" /></AttachmentPrimitive.Remove>}
    </AttachmentPrimitive.Root>
  );
}

function FollowupSuggestions() {
  return (
    <ThreadPrimitive.Suggestions>
      {({ suggestion }) => <SuggestionPrimitive.Trigger send className="mb-2 mr-2 rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent">{suggestion.prompt}</SuggestionPrimitive.Trigger>}
    </ThreadPrimitive.Suggestions>
  );
}
