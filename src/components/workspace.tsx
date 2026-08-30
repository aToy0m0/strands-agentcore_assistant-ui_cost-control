import { useEffect, useState } from "react";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import { useTheme } from "next-themes";
import { LogOut, Maximize2, Menu, Minimize2, Settings, UserRound } from "lucide-react";
import { toast } from "sonner";
import type { RuntimeConfig } from "@/config";
import { agent } from "@/lib/agents";
import { userViewFromIdTokenClaims } from "@/lib/current-user";
import { cn } from "@/lib/utils";
import { AgUiRuntimeProvider } from "./runtime/ag-ui-runtime-provider";
import { ChatThread } from "./chat-thread";
import { ConversationSidebar, type Project, type UserView } from "./conversation-sidebar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Toaster } from "./ui/sonner";

export function Workspace({ config, onSignedOut }: { config: RuntimeConfig; onSignedOut: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserView>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

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
    window.addEventListener("workmate-feedback", feedback);
    window.addEventListener("workmate-error", runtimeError);
    return () => {
      window.removeEventListener("workmate-feedback", feedback);
      window.removeEventListener("workmate-error", runtimeError);
    };
  }, []);

  return (
    <AgUiRuntimeProvider config={config}>
      <div className="flex h-dvh w-full bg-background text-foreground">
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
        <main className="relative flex min-w-0 flex-1 flex-col">
          <header className={cn("relative flex h-13 shrink-0 items-center justify-between px-3 sm:px-4", !immersive && "border-b")}>
            {!immersive && <button type="button" className="grid size-9 place-items-center rounded-lg hover:bg-accent md:hidden" aria-label="会話メニューを開く" onClick={() => setMobileSidebarOpen(true)}><Menu className="size-5" /></button>}
            {!immersive && <div className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-muted px-5 py-2 text-xs font-semibold">{agent.name}</div>}
            <button type="button" className="ml-auto grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={immersive ? "全画面を終了" : "全画面表示"} onClick={() => setImmersive((value) => !value)}>{immersive ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>
          </header>
          <ChatThread agent={agent} selectedProject={selectedProject} onClearSelectedProject={() => setSelectedProjectId(undefined)} />
        </main>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} config={config} onSignOut={() => void signOutOfWorkspace()} />
        <Toaster sidebarWidth={immersive ? 0 : sidebarOpen ? 238 : 48} />
      </div>
    </AgUiRuntimeProvider>
  );
}

function SettingsDialog({ open, onOpenChange, config, onSignOut }: { open: boolean; onOpenChange: (open: boolean) => void; config: RuntimeConfig; onSignOut: () => void }) {
  const { theme, setTheme } = useTheme();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-h-[500px] overflow-hidden p-0">
        <header className="border-b px-6 py-5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-agent">Workspace</p>
          <DialogTitle className="text-xl font-semibold">設定</DialogTitle>
          <DialogDescription className="sr-only">外観とAgentCore接続設定</DialogDescription>
        </header>
        <Tabs defaultValue="general" orientation="vertical" className="grid min-h-[420px] grid-cols-[160px_1fr] max-sm:grid-cols-1">
          <TabsList className="flex flex-col gap-1 border-r bg-muted/40 p-3 max-sm:flex-row max-sm:border-b max-sm:border-r-0">
            <TabsTrigger value="general"><UserRound className="size-4" />一般</TabsTrigger>
            <TabsTrigger value="connection"><Settings className="size-4" />接続</TabsTrigger>
          </TabsList>
          <div className="p-6">
            <TabsContent value="general" className="space-y-6">
              <div className="flex items-center justify-between gap-4"><span><strong className="block text-sm">外観</strong><small className="text-xs text-muted-foreground">アプリ全体のカラーテーマ</small></span><Select value={theme ?? "system"} onValueChange={setTheme}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="system">システム</SelectItem><SelectItem value="light">ライト</SelectItem><SelectItem value="dark">ダーク</SelectItem></SelectContent></Select></div>
              <div className="flex items-center justify-between gap-4 border-t pt-5"><span><strong className="block text-sm">セッション</strong><small className="text-xs text-muted-foreground">Cognitoの認証セッションを終了</small></span><Button type="button" variant="outline" onClick={onSignOut}><LogOut className="size-4" />ログアウト</Button></div>
            </TabsContent>
            <TabsContent value="connection" className="space-y-5">
              <div className="rounded-xl border bg-card p-4"><strong className="text-sm">{agent.name}</strong><p className="mt-1 text-xs text-muted-foreground">{agent.description}</p></div>
              <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                <ConnectionField id="runtime-id" label="Runtime" value="Browser direct / CodeZip" />
                <ConnectionField id="session-id" label="Session ID" value="一時的なconversation UUID" />
                <ConnectionField id="transport" label="Transport" value="AG-UI over SSE" />
                <ConnectionField id="auth" label="Authentication" value={config.auth.entraEnabled ? "Cognito + Entra ID" : "Cognito"} />
                <ConnectionField id="debug" label="Browser debug" value={config.debug ? "ON" : "OFF"} />
              </div>
              <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">BFFとデータベースはありません。チャット、プロジェクト、フィードバックは再読み込み後に保持されません。</p>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionField({ id, label, value }: { id: string; label: string; value: string }) {
  return <div className="space-y-1"><label htmlFor={id} className="text-xs text-muted-foreground">{label}</label><Input id={id} value={value} readOnly className="h-9 bg-muted/50 text-xs" /></div>;
}
