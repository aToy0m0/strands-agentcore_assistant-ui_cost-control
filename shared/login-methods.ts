export const LOGIN_METHOD_VALUES = ["cognito", "entra", "cognito-and-entra"] as const;

/**
 * ログイン画面に表示する認証手段。
 *
 * これは画面表示の制御であり、Cognito App Client側の認証方式を無効化するものではない。
 * `entra`を選んでもCognitoのパスワード認証自体は有効なままである。
 */
export type LoginMethods = (typeof LOGIN_METHOD_VALUES)[number];

export function isLoginMethods(value: unknown): value is LoginMethods {
  return typeof value === "string" && (LOGIN_METHOD_VALUES as readonly string[]).includes(value);
}

/**
 * CDKコンテキストやruntime-config.jsonの値を検証して確定させる。
 *
 * 未指定のときは、Entraが有効なら両方、無効ならCognitoのみを既定とする。
 * Entraが無効なのにEntraを表示する指定は、ログインできない画面になるため拒否する。
 */
export function resolveLoginMethods(configured: unknown, entraEnabled: boolean): LoginMethods {
  if (configured === undefined || configured === null) return entraEnabled ? "cognito-and-entra" : "cognito";
  if (!isLoginMethods(configured)) {
    throw new Error(`loginMethods must be one of: ${LOGIN_METHOD_VALUES.join(", ")}`);
  }
  if (configured !== "cognito" && !entraEnabled) {
    throw new Error(`loginMethods=${configured} requires entraEnabled=true`);
  }
  return configured;
}

export function showsCognitoLogin(methods: LoginMethods): boolean {
  return methods !== "entra";
}

export function showsEntraLogin(methods: LoginMethods): boolean {
  return methods !== "cognito";
}
