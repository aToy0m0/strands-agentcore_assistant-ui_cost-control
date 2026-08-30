/**
 * Runtimeの構造化ログ。CloudWatch Logs Insightsで検索できるよう1行1JSONで出す。
 *
 * 種別ごとにデプロイ時のCDKコンテキストで無効化できる。既定は有効で、モデルの入出力本文も
 * 記録する。本文には利用者の入力とモデルの応答がそのまま含まれるため、個人情報や秘密情報を
 * 扱う環境では該当種別を無効にしてから使う。
 *
 * `error`は切り替えの対象にしない。障害調査の最後の手段を消さないためである。
 */

export const LOG_CATEGORIES = ["request", "model", "tool"] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];
export type LogSettings = Record<LogCategory, boolean>;

const ENVIRONMENT_VARIABLE: Record<LogCategory, string> = {
  request: "RUNTIME_LOG_REQUEST",
  model: "RUNTIME_LOG_MODEL",
  tool: "RUNTIME_LOG_TOOL",
};

const DISABLED_VALUES = new Set(["off", "false", "0", "no"]);

/** 未設定なら有効。明示的に無効を示す値のときだけ無効にする。 */
export function parseLogSettings(environment: NodeJS.ProcessEnv): LogSettings {
  const entries = LOG_CATEGORIES.map((category) => {
    const raw = environment[ENVIRONMENT_VARIABLE[category]]?.trim().toLowerCase();
    return [category, raw === undefined || raw === "" ? true : !DISABLED_VALUES.has(raw)] as const;
  });
  return Object.fromEntries(entries) as LogSettings;
}

export type LogSink = (line: string) => void;

export type RuntimeLogger = {
  readonly settings: LogSettings;
  log: (category: LogCategory, event: string, fields: Record<string, unknown>) => void;
  error: (event: string, fields: Record<string, unknown>) => void;
};

function serialize(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    // 循環参照などで落とすとログのために本処理を壊すことになる。握りつぶさず、その旨を残す。
    return JSON.stringify({ event: payload.event, serializationFailed: true });
  }
}

export function createRuntimeLogger(settings: LogSettings, sink: LogSink = console.log, errorSink: LogSink = console.error): RuntimeLogger {
  return {
    settings,
    log(category, event, fields) {
      if (!settings[category]) return;
      sink(serialize({ event, category, ...fields }));
    },
    error(event, fields) {
      errorSink(serialize({ event, category: "error", ...fields }));
    },
  };
}
