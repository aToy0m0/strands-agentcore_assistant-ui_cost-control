"use client";

import {
  createElement,
  useState,
  type CSSProperties,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { UserView } from "@/lib/current-user";
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  Code2,
  Ellipsis,
  FlaskConical,
  FolderKanban,
  Globe2,
  GraduationCap,
  Heart,
  LogOut,
  MessageCircle,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plane,
  Plus,
  Rocket,
  Search,
  Settings,
  SquarePen,
  Sparkles,
  TerminalSquare,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

type SidebarProps = {
  open: boolean;
  mobileOpen: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  onCloseMobile: () => void;
  onOpenSettings: () => void;
  projects: Project[];
  onProjectsChange: Dispatch<SetStateAction<Project[]>>;
  selectedProjectId?: string;
  onSelectedProjectChange: (projectId?: string) => void;
  currentUser?: UserView;
  onSignOut: () => void;
};

export type { UserView };

const projectIcons = [
  { id: "folder", label: "フォルダー", icon: FolderKanban },
  { id: "plane", label: "飛行機", icon: Plane },
  { id: "sparkles", label: "ひらめき", icon: Sparkles },
  { id: "briefcase", label: "仕事", icon: BriefcaseBusiness },
  { id: "code", label: "コード", icon: Code2 },
  { id: "rocket", label: "ロケット", icon: Rocket },
  { id: "book", label: "本", icon: BookOpen },
  { id: "school", label: "学習", icon: GraduationCap },
  { id: "terminal", label: "ターミナル", icon: TerminalSquare },
  { id: "chart", label: "グラフ", icon: BarChart3 },
  { id: "science", label: "研究", icon: FlaskConical },
  { id: "tools", label: "ツール", icon: Wrench },
  { id: "heart", label: "ハート", icon: Heart },
  { id: "global", label: "グローバル", icon: Globe2 },
] as const;

type ProjectIcon = (typeof projectIcons)[number]["id"];
type ProjectMemory = "default" | "isolated";
export type Project = {
  id: string;
  name: string;
  icon: ProjectIcon;
  color: string;
  memory: ProjectMemory;
  pinned: boolean;
  version: number;
  role: string;
  threadCount: number;
};
type ProjectDraft = Pick<Project, "name" | "icon" | "color" | "memory">;
type SectionKey = "pinned" | "projects" | "chats" | "archive";

function isVisibleThread(item: {
  title?: string;
  custom?: Record<string, unknown>;
}) {
  return Boolean(
    item.title &&
      (item.title !== "新しいチャット" || item.custom?.started === true),
  );
}

function ProjectIconGlyph({
  icon,
  className,
  style,
}: {
  icon: ProjectIcon;
  className?: string;
  style?: CSSProperties;
}) {
  const definition = projectIcons.find((candidate) => candidate.id === icon);
  if (!definition) throw new Error(`未定義のプロジェクトアイコンです: ${icon}`);
  return createElement(definition.icon, { className, style });
}

export function ConversationSidebar(props: SidebarProps) {
  const api = useAui();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project>();
  const [renamingProject, setRenamingProject] = useState<Project>();
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [projectsBeforeChats, setProjectsBeforeChats] = useState(true);
  const [clearArchiveOpen, setClearArchiveOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>(
    { pinned: true, projects: true, chats: true, archive: false },
  );
  const threadItems = useAuiState((state) => state.threads.threadItems);
  const regularThreadCount = threadItems.filter(
    (item) =>
      item.status === "regular" &&
      isVisibleThread(item) &&
      typeof item.custom?.projectId !== "string",
  ).length;
  const pinnedThreadCount = threadItems.filter(
    (item) =>
      item.status === "regular" &&
      isVisibleThread(item) &&
      item.custom?.pinned === true,
  ).length;
  const pinnedProjects = props.projects.filter((project) => project.pinned);
  const archivedThreadIds = useAuiState((state) => state.threads.archivedThreadIds);
  const archivedThreadCount = archivedThreadIds.length;

  function setSection(section: SectionKey, open: boolean) {
    setOpenSections((current) => ({ ...current, [section]: open }));
  }

  function selectProject(projectId: string) {
    props.onSelectedProjectChange(projectId);
    props.onCloseMobile();
  }

  async function createProjectConversation(projectId: string) {
    try {
      props.onSelectedProjectChange(projectId);
      await api.threads.switchToNewThread();
      props.onCloseMobile();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "プロジェクトを登録先に設定できませんでした",
      );
    }
  }

  async function deleteAllArchivedThreads() {
    try {
      await Promise.all(archivedThreadIds.map((id) => api.threads.item({ id }).delete()));
      setClearArchiveOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "アーカイブを削除できませんでした",
      );
    }
  }

  async function deleteProject(projectId: string) {
    const project = props.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("削除対象のプロジェクトがありません");
    for (const item of threadItems) {
      if (item.custom?.projectId !== projectId) continue;
      const { projectId: _projectId, ...remainingCustom } = item.custom;
      void _projectId;
      api.threads
        .item({ id: item.id })
        .updateCustom(
          Object.keys(remainingCustom).length > 0 ? remainingCustom : undefined,
        );
    }
    props.onProjectsChange((current) =>
      current.filter((item) => item.id !== projectId),
    );
    if (props.selectedProjectId === projectId)
      props.onSelectedProjectChange(undefined);
  }

  async function togglePin(project: Project) {
    props.onProjectsChange((current) =>
      current.map((item) => item.id === project.id ? { ...item, pinned: !item.pinned, version: item.version + 1 } : item),
    );
  }

  async function saveProject(draft: ProjectDraft) {
    const updated: Project = editingProject
      ? { ...editingProject, ...draft, version: editingProject.version + 1 }
      : { id: crypto.randomUUID(), ...draft, pinned: false, version: 1, role: "OWNER", threadCount: 0 };
    props.onProjectsChange((current) =>
      editingProject
        ? current.map((item) => (item.id === updated.id ? updated : item))
        : [...current, updated],
    );
    props.onSelectedProjectChange(updated.id);
    setProjectDialogOpen(false);
  }

  async function renameProject(name: string) {
    if (!renamingProject)
      throw new Error("名称変更対象のプロジェクトがありません");
    const updated = { ...renamingProject, name, version: renamingProject.version + 1 };
    props.onProjectsChange((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
    setRenamingProject(undefined);
  }

  return (
    <>
      {props.mobileOpen && (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          aria-label="会話メニューを閉じる"
          onClick={props.onCloseMobile}
        />
      )}
      <aside
        data-testid="conversation-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[238px] shrink-0 flex-col border-r bg-background shadow-xl transition-[width,transform] md:relative md:z-auto md:bg-muted/55 md:shadow-none",
          !props.mobileOpen && "-translate-x-full md:translate-x-0",
          !props.open && "md:w-12",
        )}
      >
        {!props.open ? (
          <TooltipProvider delayDuration={250}>
            <div className="hidden h-full flex-col items-center gap-1 px-1.5 py-2 md:flex">
              <RailAction label="サイドバーを開く">
                <button
                  type="button"
                  className="mb-1 grid size-9 place-items-center rounded-xl hover:bg-accent"
                  aria-label="サイドバーを開く"
                  onClick={props.onExpand}
                >
                  <PanelLeftOpen className="size-5" />
                </button>
              </RailAction>
              <RailAction label="新しいチャット">
                <ThreadListPrimitive.New
                  className="grid size-9 place-items-center rounded-lg hover:bg-accent"
                  aria-label="新しいチャット"
                >
                  <SquarePen className="size-4" />
                </ThreadListPrimitive.New>
              </RailAction>
              <RailAction label="ピン留め">
                <button
                  type="button"
                  className="grid size-9 place-items-center rounded-lg hover:bg-accent"
                  aria-label="ピン留めを表示"
                  onClick={props.onExpand}
                >
                  <Pin className="size-4" />
                </button>
              </RailAction>
              <RailAction label="チャット">
                <button
                  type="button"
                  className="grid size-9 place-items-center rounded-lg hover:bg-accent"
                  aria-label="会話履歴を表示"
                  onClick={props.onExpand}
                >
                  <MessageCircle className="size-4" />
                </button>
              </RailAction>
              <UserMenu
                compact
                currentUser={props.currentUser}
                onOpenSettings={props.onOpenSettings}
                onSignOut={props.onSignOut}
              />
            </div>
          </TooltipProvider>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex h-13 items-center px-3">
              <div className="flex min-w-0 flex-1 items-center">
                {searchOpen ? (
                  <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-background px-2 shadow-sm">
                    <Search className="size-4 shrink-0 text-muted-foreground" />
                    <label className="sr-only" htmlFor="sidebar-search">
                      チャットを検索
                    </label>
                    <Input
                      id="sidebar-search"
                      autoFocus
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setSearchOpen(false);
                      }}
                      className="h-8 min-w-0 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                      placeholder="チャットを検索"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label="検索を閉じる"
                      onClick={() => {
                        setSearchOpen(false);
                        setSearch("");
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="チャットを検索"
                    onClick={() => setSearchOpen(true)}
                  >
                    <Search className="size-4" />
                  </Button>
                )}
              </div>
              <div className="ml-2 mr-[13px] flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 md:hidden"
                  aria-label="会話メニューを閉じる"
                  onClick={props.onCloseMobile}
                >
                  <X className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="hidden size-7 md:inline-flex"
                  aria-label="サイドバーを閉じる"
                  onClick={props.onCollapse}
                >
                  <PanelLeftClose className="size-4" />
                </Button>
              </div>
            </header>

            <ThreadListPrimitive.Root className="flex min-h-0 flex-1 flex-col px-2">
              <ThreadListPrimitive.New
                className="flex min-h-9 w-full items-center gap-2 rounded-lg bg-accent px-2.5 text-left text-sm"
                onClick={() => {
                  props.onSelectedProjectChange(undefined);
                  props.onCloseMobile();
                }}
              >
                <SquarePen className="size-4" />
                新しいチャット
              </ThreadListPrimitive.New>

              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2 [scrollbar-gutter:stable]">
                <SidebarSection
                  title="ピン留め"
                  open={openSections.pinned}
                  onOpenChange={(open) => setSection("pinned", open)}
                  className="order-0"
                >
                  {pinnedProjects.length === 0 && pinnedThreadCount === 0 ? (
                    <p className="px-8 py-1.5 text-[11px] text-muted-foreground">
                      ピン留めはありません
                    </p>
                  ) : (
                    <>
                      {pinnedProjects.map((project) => (
                        <Button
                          key={project.id}
                          type="button"
                          variant="ghost"
                          className="ml-4 min-h-8 w-auto justify-start gap-2 px-2.5 text-xs font-normal"
                          onClick={() => selectProject(project.id)}
                        >
                          <ProjectIconGlyph
                            icon={project.icon}
                            className="size-4"
                            style={{ color: project.color }}
                          />
                          <span className="truncate">{project.name}</span>
                        </Button>
                      ))}
                      {pinnedThreadCount > 0 && (
                        <ThreadListPrimitive.Items>
                          {() => (
                            <ConversationItem
                              search={search}
                              pinnedOnly
                            onSelected={(projectId) => {
                              props.onSelectedProjectChange(projectId);
                              props.onCloseMobile();
                            }}
                            />
                          )}
                        </ThreadListPrimitive.Items>
                      )}
                    </>
                  )}
                </SidebarSection>

                <SidebarSection
                  title="プロジェクト"
                  open={openSections.projects}
                  onOpenChange={(open) => setSection("projects", open)}
                  className={projectsBeforeChats ? "order-1" : "order-2"}
                  actions={
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="新規プロジェクトを作成"
                        onClick={() => {
                          setEditingProject(undefined);
                          setProjectDialogOpen(true);
                        }}
                      >
                        <Plus className="size-4" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label="プロジェクトの表示設定"
                          >
                            <Ellipsis className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          side="right"
                          align="start"
                          className="w-52"
                        >
                          <DropdownMenuItem
                            onSelect={() =>
                              setProjectsBeforeChats((current) => !current)
                            }
                          >
                            <ChevronDown className="size-4" />
                            チャットと順序を入れ替える
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  }
                >
                  {props.projects.length === 0 && (
                    <p className="px-2 py-1 text-[11px] text-muted-foreground">
                      プロジェクトはありません
                    </p>
                  )}
                  {(showAllProjects
                    ? props.projects
                    : props.projects.slice(0, 4)
                  ).map((project) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      selected={props.selectedProjectId === project.id}
                      search={search}
                      threadCount={
                        threadItems.filter(
                          (item) =>
                            item.status === "regular" &&
                            isVisibleThread(item) &&
                            item.custom?.projectId === project.id,
                        ).length
                      }
                      onSelect={() => selectProject(project.id)}
                      onCreateConversation={() =>
                        void createProjectConversation(project.id)
                      }
                      onThreadSelected={() => selectProject(project.id)}
                      onRename={() => setRenamingProject(project)}
                      onSettings={() => {
                        setEditingProject(project);
                        setProjectDialogOpen(true);
                      }}
                      onPin={() =>
                        void togglePin(project).catch((error: unknown) =>
                          toast.error(
                            error instanceof Error
                              ? error.message
                              : "ピン留めを更新できませんでした",
                          ),
                        )
                      }
                      onDelete={() =>
                        void deleteProject(project.id).catch((error: unknown) =>
                          toast.error(
                            error instanceof Error
                              ? error.message
                              : "プロジェクトを削除できませんでした",
                          ),
                        )
                      }
                    />
                  ))}
                  {props.projects.length > 4 && (
                    <button
                      type="button"
                      className="flex min-h-8 w-full items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent"
                      onClick={() => setShowAllProjects((value) => !value)}
                    >
                      {showAllProjects
                        ? "折りたたむ"
                        : `さらに表示 (${props.projects.length - 4})`}
                      <ChevronRight
                        className={cn(
                          "size-3 transition-transform",
                          showAllProjects && "rotate-90",
                        )}
                      />
                    </button>
                  )}
                </SidebarSection>

                <SidebarSection
                  title="チャット"
                  open={openSections.chats}
                  onOpenChange={(open) => setSection("chats", open)}
                  className={projectsBeforeChats ? "order-2" : "order-1"}
                  actions={
                    <>
                      <ThreadListPrimitive.New
                        className="grid size-7 place-items-center rounded-md hover:bg-accent"
                        aria-label="新しいチャットを作成"
                        onClick={() => {
                          props.onSelectedProjectChange(undefined);
                          props.onCloseMobile();
                        }}
                      >
                        <SquarePen className="size-3.5" />
                      </ThreadListPrimitive.New>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label="チャットの表示設定"
                          >
                            <Ellipsis className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          side="right"
                          align="start"
                          className="w-52"
                        >
                          <DropdownMenuItem
                            onSelect={() =>
                              setProjectsBeforeChats((current) => !current)
                            }
                          >
                            <ChevronDown className="size-4" />
                            プロジェクトと順序を入れ替える
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  }
                >
                  {regularThreadCount === 0 ? (
                    <p className="px-8 py-1.5 text-[11px] text-muted-foreground">
                      チャットはまだありません
                    </p>
                  ) : (
                    <ThreadListPrimitive.Items>
                      {() => (
                        <ConversationItem
                          search={search}
                          excludeProjectThreads
                        onSelected={(projectId) => {
                          props.onSelectedProjectChange(projectId);
                          props.onCloseMobile();
                        }}
                        />
                      )}
                    </ThreadListPrimitive.Items>
                  )}
                </SidebarSection>

                <SidebarSection
                  title="アーカイブ"
                  open={openSections.archive}
                  onOpenChange={(open) => setSection("archive", open)}
                  className="order-3"
                  actions={
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="アーカイブ操作"
                        >
                          <Ellipsis className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        side="right"
                        align="start"
                        className="w-44"
                      >
                        <DropdownMenuItem
                          className="text-destructive"
                          disabled={archivedThreadCount === 0}
                          onSelect={() => setClearArchiveOpen(true)}
                        >
                          <Trash2 className="size-4" />
                          すべて削除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                >
                  {archivedThreadCount === 0 ? (
                    <p className="px-8 py-1.5 text-[11px] text-muted-foreground">
                      アーカイブはまだありません
                    </p>
                  ) : (
                    <ThreadListPrimitive.Items archived>
                      {() => (
                        <ConversationItem
                          search={search}
                          archived
                        onSelected={(projectId) => {
                          props.onSelectedProjectChange(projectId);
                          props.onCloseMobile();
                        }}
                        />
                      )}
                    </ThreadListPrimitive.Items>
                  )}
                </SidebarSection>
              </div>
            </ThreadListPrimitive.Root>
            <UserMenu
              currentUser={props.currentUser}
              onOpenSettings={props.onOpenSettings}
              onSignOut={props.onSignOut}
            />
          </div>
        )}
      </aside>
      <ProjectDialog
        key={editingProject?.id ?? "new"}
        open={projectDialogOpen}
        project={editingProject}
        onOpenChange={setProjectDialogOpen}
        onSave={saveProject}
      />
      <ProjectRenameDialog
        key={renamingProject?.id ?? "none"}
        project={renamingProject}
        onClose={() => setRenamingProject(undefined)}
        onRename={(name) =>
          void renameProject(name).catch((error: unknown) =>
            toast.error(
              error instanceof Error
                ? error.message
                : "プロジェクト名を変更できませんでした",
            ),
          )
        }
      />
      <AlertDialog open={clearArchiveOpen} onOpenChange={setClearArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              アーカイブをすべて削除しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              アーカイブ内の会話は元に戻せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">キャンセル</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                variant="destructive"
                onClick={() => void deleteAllArchivedThreads()}
              >
                すべて削除
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SidebarSection({
  title,
  open,
  onOpenChange,
  actions,
  children,
  className,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={cn("mt-2", className)}
      data-sidebar-section={title}
    >
      <div className="flex min-h-9 items-center rounded-lg transition-colors hover:bg-accent">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="min-h-9 min-w-0 flex-1 justify-start gap-1.5 px-2.5 text-left text-[11px] font-semibold"
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                !open && "-rotate-90",
              )}
            />
            {title}
          </Button>
        </CollapsibleTrigger>
        <div className="grid shrink-0 grid-flow-col auto-cols-[28px] pr-0.5">
          {actions}
        </div>
      </div>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-[section-open_160ms_ease-out] data-[state=closed]:animate-[section-close_120ms_ease-in]">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function RailAction({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function ProjectRow({
  project,
  selected,
  search,
  threadCount,
  onSelect,
  onCreateConversation,
  onThreadSelected,
  onRename,
  onSettings,
  onPin,
  onDelete,
}: {
  project: Project;
  selected: boolean;
  search: string;
  threadCount: number;
  onSelect: () => void;
  onCreateConversation: () => void;
  onThreadSelected: () => void;
  onRename: () => void;
  onSettings: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);

  async function share() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${window.location.pathname}#project=${project.id}`,
      );
      toast.success("プロジェクトの共有リンクをコピーしました");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "共有リンクのコピーに失敗しました",
      );
    }
  }

  return (
    <Collapsible
      open={historyOpen}
      onOpenChange={setHistoryOpen}
      className={cn("rounded-lg", selected && "bg-accent")}
    >
      <div className="flex min-h-9 items-center rounded-lg pr-0.5 transition-colors hover:bg-accent">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="ml-2 size-7 shrink-0"
            aria-label={`${project.name}のチャット履歴を${historyOpen ? "折りたたむ" : "表示"}`}
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform",
                historyOpen && "rotate-90",
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <Button
          type="button"
          variant="ghost"
          className="min-h-8 min-w-0 flex-1 justify-start gap-2 px-1 text-xs font-normal"
          aria-pressed={selected}
          onClick={() => {
            setHistoryOpen((current) => !current);
            onSelect();
          }}
        >
          <ProjectIconGlyph
            icon={project.icon}
            className="size-4 shrink-0"
            style={{ color: project.color }}
          />
          <span className="truncate">{project.name}</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={`${project.name}に新しいチャットを作成`}
          onClick={onCreateConversation}
        >
          <SquarePen className="size-3.5" />
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={`${project.name}の操作`}
            >
              <Ellipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-56">
            <DropdownMenuItem onSelect={() => void share()}>
              <FolderKanban className="size-4" />
              プロジェクトを共有
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRename}>
              <Pencil className="size-4" />
              プロジェクトの名前を変更する
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onSettings}>
              <Settings className="size-4" />
              プロジェクト設定
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onPin}>
              {project.pinned ? (
                <PinOff className="size-4" />
              ) : (
                <Pin className="size-4" />
              )}
              {project.pinned ? "ピン留めを外す" : "プロジェクトをピン留め"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive"
              onSelect={() => setDeleteOpen(true)}
            >
              <Trash2 className="size-4" />
              プロジェクトを削除する
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CollapsibleContent className="pl-13">
        {threadCount === 0 ? (
          <p className="px-2 pb-2 text-[11px] text-muted-foreground">
            プロジェクトのチャットはまだありません
          </p>
        ) : (
          <ThreadListPrimitive.Items>
            {() => (
              <ConversationItem
                search={search}
                projectId={project.id}
                onSelected={onThreadSelected}
              />
            )}
          </ThreadListPrimitive.Items>
        )}
      </CollapsibleContent>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold">
              「{project.name}」を削除しますか？
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              この操作は元に戻せません。プロジェクトの設定が削除されます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">キャンセル</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" onClick={onDelete}>
                削除する
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Collapsible>
  );
}

function ProjectDialog({
  open,
  project,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  project?: Project;
  onOpenChange: (open: boolean) => void;
  onSave: (project: ProjectDraft) => Promise<void>;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [icon, setIcon] = useState<ProjectIcon>(project?.icon ?? "folder");
  const [color, setColor] = useState(project?.color ?? "#3b82f6");
  const [memory, setMemory] = useState<ProjectMemory>(
    project?.memory ?? "default",
  );
  const [submitting, setSubmitting] = useState(false);
  const colors = [
    "#111111",
    "#ef4444",
    "#f97316",
    "#fbbf24",
    "#22c55e",
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
  ];
  const validColor = /^#[0-9a-f]{6}$/i.test(color);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const projectName = name.trim();
    if (!projectName || !validColor || submitting) return;
    setSubmitting(true);
    try {
      await onSave({ name: projectName, icon, color, memory });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "プロジェクトを保存できませんでした",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="text-lg font-semibold">
          {project ? "プロジェクト設定" : "プロジェクトを作成する"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          プロジェクトの名前、外観、メモリ方式を設定します。
        </DialogDescription>
        <form onSubmit={submit} className="mt-5 space-y-4">
          <div className="space-y-2">
            <label htmlFor="project-name" className="text-sm font-medium">
              プロジェクト名
            </label>
            <div className="flex h-10 items-center rounded-lg border focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="grid size-9 shrink-0 place-items-center rounded-md hover:bg-accent"
                    aria-label="アイコンと色を選択"
                  >
                    <ProjectIconGlyph
                      icon={icon}
                      className="size-4"
                      style={validColor ? { color } : undefined}
                    />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64">
                  <div className="grid grid-cols-6 gap-2">
                    {colors.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className="size-6 rounded-full border-2 border-background ring-offset-2 aria-pressed:ring-2 aria-pressed:ring-foreground"
                        aria-label={`色 ${preset}`}
                        aria-pressed={color.toLowerCase() === preset}
                        style={{ backgroundColor: preset }}
                        onClick={() => setColor(preset)}
                      />
                    ))}
                  </div>
                  <div className="mt-3 space-y-1">
                    <label
                      htmlFor="project-color"
                      className="text-xs text-muted-foreground"
                    >
                      カスタムカラー（Hex）
                    </label>
                    <Input
                      id="project-color"
                      value={color}
                      onChange={(event) => setColor(event.target.value)}
                      aria-invalid={!validColor}
                      className="h-9 font-mono text-xs"
                    />
                    {!validColor && (
                      <p className="text-xs text-destructive">
                        #RRGGBB形式で入力してください。
                      </p>
                    )}
                  </div>
                  <div className="my-3 h-px bg-border" />
                  <div className="grid grid-cols-7 gap-1">
                    {projectIcons.map(({ id, label, icon: CandidateIcon }) => (
                      <button
                        key={id}
                        type="button"
                        className="grid size-8 place-items-center rounded-full hover:bg-accent aria-pressed:bg-accent"
                        aria-label={label}
                        aria-pressed={icon === id}
                        onClick={() => setIcon(id)}
                      >
                        <CandidateIcon className="size-4" />
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 h-px bg-border" />
                  <PopoverClose asChild>
                    <Button
                      type="button"
                      size="sm"
                      className="mt-2 w-full bg-black text-white hover:bg-zinc-800"
                    >
                      決定
                    </Button>
                  </PopoverClose>
                </PopoverContent>
              </Popover>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-full border-0 px-1 shadow-none focus-visible:ring-0"
                placeholder="例: コペンハーゲン旅行"
              />
            </div>
          </div>
          <div className="flex gap-2 rounded-xl bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
            <Sparkles className="mt-0.5 size-4 shrink-0" />
            <p>
              プロジェクトを使用すると、チャット、ファイル、カスタム指示が1か所にまとまります。
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger className="flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs hover:bg-accent">
                {memory === "default"
                  ? "デフォルトメモリ"
                  : "プロジェクト限定メモリ"}
                <ChevronDown className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuRadioGroup
                  value={memory}
                  onValueChange={(value) => setMemory(value as ProjectMemory)}
                >
                  <DropdownMenuRadioItem
                    value="default"
                    className="items-start"
                  >
                    <span>
                      <strong className="block text-xs">
                        デフォルトメモリ
                      </strong>
                      <small className="block text-[10px] leading-relaxed text-muted-foreground">
                        プロジェクト外のチャットのメモリにもアクセスできます。
                      </small>
                    </span>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    value="isolated"
                    className="items-start"
                  >
                    <span>
                      <strong className="block text-xs">
                        プロジェクト限定メモリ
                      </strong>
                      <small className="block text-[10px] leading-relaxed text-muted-foreground">
                        このプロジェクト内だけでメモリを共有します。
                      </small>
                    </span>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="submit"
              disabled={!name.trim() || !validColor || submitting}
              aria-busy={submitting}
            >
              {submitting
                ? "保存中…"
                : project
                  ? "保存する"
                  : "プロジェクトを作成する"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectRenameDialog({
  project,
  onClose,
  onRename,
}: {
  project?: Project;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  return (
    <Dialog
      open={project != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogTitle className="text-lg font-semibold">
          プロジェクト名を変更
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          サイドバーに表示する名前を入力してください。
        </DialogDescription>
        <Input
          value={name}
          aria-label="新しいプロジェクト名"
          onChange={(event) => setName(event.target.value)}
          className="mt-4"
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button disabled={!name.trim()} onClick={() => onRename(name.trim())}>
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UserMenu({
  compact = false,
  currentUser,
  onOpenSettings,
  onSignOut,
}: {
  compact?: boolean;
  currentUser?: UserView;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const displayName = currentUser?.displayName ?? "ユーザー情報を取得中";
  const avatarText = currentUser?.displayName.trim().charAt(0) || "?";
  const roleLabel = currentUser?.roles.join(", ") ?? "";
  if (compact) {
    return (
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="mt-auto size-9 p-0"
            aria-label="ユーザーメニュー"
          >
            <Avatar>
              <AvatarFallback className="bg-black bg-none text-white">
                {avatarText}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <UserMenuContent
          displayName={displayName}
          roleLabel={roleLabel}
          onOpenSettings={onOpenSettings}
          onSignOut={onSignOut}
          onClose={() => setOpen(false)}
          align="start"
        />
      </DropdownMenu>
    );
  }
  return (
    <div className="mb-2 ml-2 mr-[25px] mt-2 flex items-center gap-1">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="grid h-auto min-w-0 flex-1 grid-cols-[32px_1fr] justify-start gap-2 p-2 text-left"
            aria-label="ユーザーメニュー"
          >
            <Avatar>
              <AvatarFallback className="bg-black bg-none text-white">
                {avatarText}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              <strong className="block truncate text-xs">{displayName}</strong>
              <small className="block truncate text-[10px] text-muted-foreground">
                {roleLabel}
              </small>
            </span>
          </Button>
        </DropdownMenuTrigger>
        <UserMenuContent
          displayName={displayName}
          roleLabel={roleLabel}
          onOpenSettings={onOpenSettings}
          onSignOut={onSignOut}
          onClose={() => setOpen(false)}
          align="center"
        />
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="設定を開く"
        onClick={onOpenSettings}
      >
        <Settings className="size-4 text-muted-foreground" />
      </Button>
    </div>
  );
}

function UserMenuContent({
  displayName,
  roleLabel,
  onOpenSettings,
  onSignOut,
  onClose,
  align,
}: {
  displayName: string;
  roleLabel: string;
  onOpenSettings: () => void;
  onSignOut: () => void;
  onClose: () => void;
  align: "start" | "center";
}) {
  return (
    <DropdownMenuContent side="top" align={align} className="w-56">
      <DropdownMenuLabel>
        <strong className="block text-xs">{displayName}</strong>
        <span className="font-normal text-muted-foreground">{roleLabel}</span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          onClose();
          window.setTimeout(onOpenSettings, 0);
        }}
      >
        <Settings className="size-4" />
        設定を開く
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          onClose();
          window.setTimeout(onSignOut, 0);
        }}
      >
        <LogOut className="size-4" />
        ログアウト
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

function ConversationItem({
  search,
  archived = false,
  projectId,
  excludeProjectThreads = false,
  pinnedOnly = false,
  onSelected,
}: {
  search: string;
  archived?: boolean;
  projectId?: string;
  excludeProjectThreads?: boolean;
  pinnedOnly?: boolean;
  onSelected: (projectId?: string) => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const api = useAui();
  const item = useAuiState((state) => state.threadListItem);
  const title = item.title ?? "新しいチャット";
  const hiddenBySearch =
    search.trim() !== "" &&
    !title.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const assignedProjectId =
    typeof item.custom?.projectId === "string"
      ? item.custom.projectId
      : undefined;
  const hiddenByProject =
    projectId !== undefined
      ? assignedProjectId !== projectId
      : excludeProjectThreads && assignedProjectId !== undefined;
  const isPinned = item.custom?.pinned === true;

  async function rename() {
    const value = draftTitle.trim();
    if (!value || renaming) return;
    setRenaming(true);
    try {
      await api.threads.item({ id: item.id }).rename(value);
      setRenameOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "チャット名を変更できませんでした",
      );
    } finally {
      setRenaming(false);
    }
  }

  if (
    hiddenBySearch ||
    hiddenByProject ||
    (pinnedOnly && !isPinned) ||
    !isVisibleThread(item)
  )
    return null;
  return (
    <ThreadListItemPrimitive.Root
      className={cn(
        "group relative flex min-h-9 items-center rounded-lg hover:bg-accent data-[active=true]:bg-accent",
        !projectId && "ml-4",
      )}
    >
      <ThreadListItemPrimitive.Trigger
        className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 pr-8 text-left text-xs"
        onClick={() => onSelected(assignedProjectId)}
      >
        <MessageSquare className="size-3.5 shrink-0" />
        <span className="truncate">
          <ThreadListItemPrimitive.Title fallback="新しいチャット" />
        </span>
      </ThreadListItemPrimitive.Trigger>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0.5 size-7 bg-transparent group-hover:bg-accent data-[state=open]:bg-accent"
            aria-label={`${title}の操作`}
          >
            <Ellipsis className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem
            onSelect={() => {
              setMenuOpen(false);
              setDraftTitle(title);
              setRenameOpen(true);
            }}
          >
            <Pencil className="size-4" />
            名前を変更
          </DropdownMenuItem>
          {!archived && (
            <DropdownMenuItem
              onSelect={() => {
                api.threads
                  .item({ id: item.id })
                  .updateCustom({ ...item.custom, pinned: !isPinned });
                setMenuOpen(false);
              }}
            >
              {isPinned ? (
                <PinOff className="size-4" />
              ) : (
                <Pin className="size-4" />
              )}
              {isPinned ? "ピン留めを外す" : "チャットをピン留め"}
            </DropdownMenuItem>
          )}
          {archived ? (
            <DropdownMenuItem asChild onSelect={() => setMenuOpen(false)}>
              <ThreadListItemPrimitive.Unarchive>
                <ArchiveRestore className="size-4" />
                元に戻す
              </ThreadListItemPrimitive.Unarchive>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem asChild onSelect={() => setMenuOpen(false)}>
              <ThreadListItemPrimitive.Archive>
                <Archive className="size-4" />
                アーカイブ
              </ThreadListItemPrimitive.Archive>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            asChild
            className="text-destructive"
            onSelect={() => setMenuOpen(false)}
          >
            <ThreadListItemPrimitive.Delete>
              <Trash2 className="size-4" />
              削除
            </ThreadListItemPrimitive.Delete>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          if (!renaming) setRenameOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
          >
            <DialogTitle className="text-lg font-semibold">
              チャット名を変更
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              会話履歴に表示する名前を入力してください（120文字以内）。
            </DialogDescription>
            <label className="sr-only" htmlFor={`thread-title-${item.id}`}>
              チャットタイトル
            </label>
            <Input
              id={`thread-title-${item.id}`}
              value={draftTitle}
              maxLength={120}
              autoFocus
              disabled={renaming}
              onChange={(event) => setDraftTitle(event.target.value)}
              className="mt-4"
            />
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={renaming}
                onClick={() => setRenameOpen(false)}
              >
                キャンセル
              </Button>
              <Button
                type="submit"
                disabled={!draftTitle.trim() || renaming}
                aria-busy={renaming}
              >
                {renaming ? "保存中…" : "保存"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </ThreadListItemPrimitive.Root>
  );
}
