import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useAuiState } from "@assistant-ui/react";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import { useTheme } from "next-themes";
import { LogOut, Maximize2, Menu, Minimize2 } from "lucide-react";
import { toast } from "sonner";
import type { RuntimeAgent, RuntimeConfig } from "@/config";
import { createAgentProfile } from "@/lib/agents";
import { userViewFromIdTokenClaims } from "@/lib/current-user";
import { isMobileSidebarOpeningSwipe, type SwipePoint } from "@/lib/mobile-sidebar-gesture";
import { resolveAppViewport, type AppViewport } from "@/lib/visual-viewport";
import { cn } from "@/lib/utils";
import { AgUiRuntimeProvider } from "./runtime/ag-ui-runtime-provider";
import { ChatThread } from "./chat-thread";
import { ConversationSidebar, type Project, type UserView } from "./conversation-sidebar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Toaster } from "./ui/sonner";

export function Workspace({ config, onSignedOut }: { config: RuntimeConfig; onSignedOut: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserView>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [selectedAgentId, setSelectedAgentId] = useState(config.defaultAgentId);
  const [appViewport, setAppViewport] = useState<AppViewport>();
  const swipeStart = useRef<SwipePoint | undefined>(undefined);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedAgent = config.agents.find((agent) => agent.id === selectedAgentId);
  if (!selectedAgent) throw new Error(`未定義のRuntimeです: ${selectedAgentId}`);
  const agent = createAgentProfile(selectedAgent.id, selectedAgent.name, selectedAgent.description);

  function startSidebarSwipe(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch" || mobileSidebarOpen || immersive) return;
    swipeStart.current = { x: event.clientX, y: event.clientY };
  }

  function finishSidebarSwipe(event: ReactPointerEvent<HTMLDivElement>) {
    const start = swipeStart.current;
    swipeStart.current = undefined;
    if (!start || event.pointerType !== "touch") return;
    if (isMobileSidebarOpeningSwipe(start, { x: event.clientX, y: event.clientY }, window.innerWidth)) {
      setMobileSidebarOpen(true);
    }
  }

  async function signOutOfWorkspace() {
    try {
      await signOut();
      setSettingsOpen(false);
      onSignedOut();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "ログアウトに失敗しました");
    }
  }

  useEffect(() => {
    void fetchAuthSession().then((session) => setCurrentUser(userViewFromIdTokenClaims(session.tokens?.idToken?.payload))).catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : "ユーザー情報を取得できませんでした"));
    const feedback = () => toast.success("フィードバックはこの簡易構成では保存されません");
    const runtimeError = (event: Event) => toast.error(`AG-UIエラー: ${(event as CustomEvent<string>).detail}`);
    window.addEventListener("agent-feedback", feedback);
    window.addEventListener("agent-error", runtimeError);
    return () => {
      window.removeEventListener("agent-feedback", feedback);
      window.removeEventListener("agent-error", runtimeError);
    };
  }, []);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    const update = () => setAppViewport(resolveAppViewport(
      window.innerHeight,
      visualViewport ? { height: visualViewport.height, offsetTop: visualViewport.offsetTop } : undefined,
      window.matchMedia("(max-width: 767px)").matches,
    ));
    update();
    window.addEventListener("resize", update, { passive: true });
    visualViewport?.addEventListener("resize", update, { passive: true });
    visualViewport?.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("resize", update);
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
    };
  }, []);

  const viewportStyle = appViewport ? {
    height: `${appViewport.height}px`,
    top: `${appViewport.offsetTop}px`,
  } satisfies CSSProperties : undefined;

  return (
    <AgUiRuntimeProvider key={selectedAgent.id} config={config} agent={selectedAgent}>
      <div
        className="fixed inset-x-0 top-0 flex h-dvh w-full max-w-full overflow-hidden bg-background text-foreground"
        style={viewportStyle}
        data-keyboard-open={appViewport?.keyboardOpen ? "true" : "false"}
        onPointerDown={startSidebarSwipe}
        onPointerUp={finishSidebarSwipe}
        onPointerCancel={() => { swipeStart.current = undefined; }}
      >
        <div className={immersive ? "hidden" : "contents"}>
          <ConversationSidebar
            open={sidebarOpen} mobileOpen={mobileSidebarOpen}
            onCollapse={() => setSidebarOpen(false)} onExpand={() => setSidebarOpen(true)}
            onCloseMobile={() => setMobileSidebarOpen(false)} onOpenSettings={() => setSettingsOpen(true)}
            projects={projects} onProjectsChange={setProjects}
            selectedProjectId={selectedProjectId} onSelectedProjectChange={setSelectedProjectId}
            currentUser={currentUser}
            onSignOut={() => void signOutOfWorkspace()}
          />
        </div>
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <header className={cn("relative flex h-13 shrink-0 items-center justify-between px-3 sm:px-4", !immersive && "border-b")}>
            {!immersive && <button type="button" className="grid size-9 place-items-center rounded-lg hover:bg-accent md:hidden" aria-label="会話メニューを開く" onClick={() => setMobileSidebarOpen(true)}><Menu className="size-5" /></button>}
            {!immersive && <RuntimeSelector agents={config.agents} selectedAgentId={selectedAgent.id} onAgentChange={setSelectedAgentId} />}
            <button type="button" className="ml-auto grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={immersive ? "全画面を終了" : "全画面表示"} onClick={() => setImmersive((value) => !value)}>{immersive ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>
          </header>
          <ChatThread agent={agent} selectedProject={selectedProject} keyboardOpen={appViewport?.keyboardOpen === true} onClearSelectedProject={() => setSelectedProjectId(undefined)} />
        </main>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onSignOut={() => void signOutOfWorkspace()} />
        <Toaster sidebarWidth={immersive ? 0 : sidebarOpen ? 238 : 48} />
      </div>
    </AgUiRuntimeProvider>
  );
}

function RuntimeSelector({ agents, selectedAgentId, onAgentChange }: { agents: RuntimeAgent[]; selectedAgentId: string; onAgentChange: (agentId: string) => void }) {
  const switchBlocked = useAuiState((state) => state.thread.isRunning
    || state.thread.messages.some((message) => message.status?.type === "requires-action"));
  return (
    <div className="absolute left-1/2 top-1.5 w-[min(280px,55vw)] -translate-x-1/2">
      <Select value={selectedAgentId} onValueChange={onAgentChange} disabled={switchBlocked}>
        <SelectTrigger className="h-10 rounded-full px-4 text-xs font-semibold" aria-label="アプリを選択">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="rounded-[24px]">
          {agents.map((agent) => <SelectItem className="rounded-full" key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function SettingsDialog({ open, onOpenChange, onSignOut }: { open: boolean; onOpenChange: (open: boolean) => void; onSignOut: () => void }) {
  const { theme, setTheme } = useTheme();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0">
        <header className="border-b px-6 py-5">
          <DialogTitle className="text-xl font-semibold">設定</DialogTitle>
          <DialogDescription className="sr-only">外観と認証セッションの設定</DialogDescription>
        </header>
        <div className="space-y-6 p-6">
          <div className="flex items-center justify-between gap-4"><span><strong className="block text-sm">外観</strong><small className="text-xs text-muted-foreground">アプリ全体のカラーテーマ</small></span><Select value={theme ?? "system"} onValueChange={setTheme}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="system">システム</SelectItem><SelectItem value="light">ライト</SelectItem><SelectItem value="dark">ダーク</SelectItem></SelectContent></Select></div>
          <div className="flex items-center justify-between gap-4 border-t pt-5"><span><strong className="block text-sm">セッション</strong><small className="text-xs text-muted-foreground">Cognitoの認証セッションを終了</small></span><Button type="button" variant="outline" onClick={onSignOut}><LogOut className="size-4" />ログアウト</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
