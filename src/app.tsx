import { useEffect, useState } from "react";
import { fetchAuthSession } from "aws-amplify/auth";
import { LoaderCircle } from "lucide-react";
import { configureAmplify, loadRuntimeConfig, type RuntimeConfig } from "./config";
import { LoginForm } from "./components/login-form";
import { Workspace } from "./components/workspace";
import { debugError, debugLog, installBrowserDebugHandlers, setDebugEnabled } from "./lib/debug";

type AppState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; config: RuntimeConfig; authenticated: boolean };

export function App() {
  const [state, setState] = useState<AppState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let removeDebugHandlers: () => void = () => undefined;
    void (async () => {
      try {
        const config = await loadRuntimeConfig();
        document.title = `${config.ui.name} AG-UI`;
        setDebugEnabled(config.debug);
        removeDebugHandlers = installBrowserDebugHandlers();
        debugLog("app.config.loaded", config);
        configureAmplify(config);
        const session = await fetchAuthSession();
        debugLog("auth.session.loaded", { authenticated: Boolean(session.tokens?.accessToken) });
        if (active) setState({ status: "ready", config, authenticated: Boolean(session.tokens?.accessToken) });
      } catch (cause) {
        debugError("app.initialization.failed", cause);
        if (active) setState({ status: "error", message: cause instanceof Error ? cause.message : "アプリを初期化できませんでした" });
      }
    })();
    return () => {
      active = false;
      removeDebugHandlers();
    };
  }, []);

  if (state.status === "loading") return <div className="grid h-dvh place-items-center text-sm text-muted-foreground"><LoaderCircle className="size-5 animate-spin" aria-label="読み込み中" /></div>;
  if (state.status === "error") return <main className="grid min-h-dvh place-items-center p-6"><div role="alert" className="max-w-lg rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive"><strong className="block text-base">初期化エラー</strong><p className="mt-2">{state.message}</p></div></main>;
  if (!state.authenticated) return <LoginForm config={state.config} onAuthenticated={() => setState({ ...state, authenticated: true })} />;
  return <Workspace config={state.config} onSignedOut={() => setState({ ...state, authenticated: false })} />;
}
