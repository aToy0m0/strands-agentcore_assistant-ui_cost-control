import { useState, type FormEvent } from "react";
import { confirmSignIn, signIn, signInWithRedirect, signOut } from "aws-amplify/auth";
import { Building2, LoaderCircle, LockKeyhole } from "lucide-react";
import { showsCognitoLogin, showsEntraLogin, type RuntimeConfig } from "@/config";
import { validateNewPassword } from "@/lib/new-password";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function LoginForm({ config, onAuthenticated }: { config: RuntimeConfig; onAuthenticated: () => void }) {
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<"credentials" | "new-password">("credentials");
  const showsCognito = showsCognitoLogin(config);
  const showsEntra = showsEntraLogin(config);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      const result = await signIn({ username: String(form.get("loginId")), password: String(form.get("password")) });
      if (!result.isSignedIn && result.nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
        setStep("new-password");
        setSubmitting(false);
        return;
      }
      if (!result.isSignedIn) throw new Error(`未対応の追加認証手順です: ${result.nextStep.signInStep}`);
      onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ログインに失敗しました。");
      setSubmitting(false);
    }
  }

  async function submitNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword"));
    const confirmation = String(form.get("newPasswordConfirmation"));
    const validationError = validateNewPassword(newPassword, confirmation);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      const result = await confirmSignIn({ challengeResponse: newPassword });
      if (!result.isSignedIn) throw new Error(`未対応の追加認証手順です: ${result.nextStep.signInStep}`);
      onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "新しいパスワードを設定できませんでした。");
      setSubmitting(false);
    }
  }

  async function returnToLogin() {
    setSubmitting(true);
    setError(undefined);
    try {
      await signOut();
      setStep("credentials");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ログイン画面へ戻れませんでした。");
    } finally {
      setSubmitting(false);
    }
  }

  async function signInWithEntra() {
    if (!config.auth.entraEnabled || !config.auth.entraProviderName) throw new Error("Entra IDログインは有効ではありません");
    setError(undefined);
    try {
      await signInWithRedirect({ provider: { custom: config.auth.entraProviderName } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Microsoftでログインできませんでした");
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-[radial-gradient(circle_at_top,var(--color-accent),transparent_55%)] p-4">
      <section className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-xl shadow-black/5 sm:p-8" aria-labelledby="login-title">
        <h1 id="login-title" className="mb-2 text-xl font-semibold">{step === "credentials" ? "ログイン" : "新しいパスワードの設定"}</h1>
        {step === "new-password" && <p className="mb-6 text-sm leading-6 text-muted-foreground">初回ログインのため、新しいパスワードを設定してください。</p>}
        {step === "credentials" && showsEntra && <Button type="button" variant="outline" className="mt-5 h-11 w-full" onClick={() => void signInWithEntra()}><Building2 className="size-4" />Microsoftで続ける</Button>}
        {step === "credentials" && showsEntra && showsCognito && <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />または<span className="h-px flex-1 bg-border" /></div>}
        {step === "credentials" && showsCognito && (
          <form className="space-y-5" onSubmit={submit}>
            <div className="space-y-2"><label htmlFor="login-id" className="text-sm font-medium">メールアドレス</label><Input id="login-id" name="loginId" type="email" autoComplete="username" required maxLength={256} disabled={submitting} /></div>
            <div className="space-y-2"><label htmlFor="password" className="text-sm font-medium">パスワード</label><Input id="password" name="password" type="password" autoComplete="current-password" required maxLength={256} disabled={submitting} /></div>
            {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <Button type="submit" className="h-11 w-full" disabled={submitting}>{submitting ? <LoaderCircle className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}{submitting ? "認証中…" : "ログイン"}</Button>
          </form>
        )}
        {step === "new-password" && (
          <form className="space-y-5" onSubmit={submitNewPassword}>
            <div className="space-y-2">
              <label htmlFor="new-password" className="text-sm font-medium">新しいパスワード</label>
              <Input id="new-password" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={submitting} autoFocus />
              <p className="text-xs leading-5 text-muted-foreground">12文字以上で、英大文字・英小文字・数字・記号をそれぞれ含めてください。</p>
            </div>
            <div className="space-y-2">
              <label htmlFor="new-password-confirmation" className="text-sm font-medium">新しいパスワード（確認）</label>
              <Input id="new-password-confirmation" name="newPasswordConfirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={submitting} />
            </div>
            {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <Button type="submit" className="h-11 w-full" disabled={submitting}>{submitting ? <LoaderCircle className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}{submitting ? "設定中…" : "変更してログイン"}</Button>
            <Button type="button" variant="ghost" className="h-11 w-full" disabled={submitting} onClick={() => void returnToLogin()}>ログイン画面へ戻る</Button>
          </form>
        )}
        {step === "credentials" && !showsCognito && error && <p role="alert" className="mt-5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </section>
    </main>
  );
}
