/** サイドバーとヘッダーに表示するログイン中ユーザー。 */
export type UserView = {
  id: string;
  tenantId: string;
  displayName: string;
  roles: string[];
};

const TENANT_ID = "cognito";
const FALLBACK_USER_ID = "cognito-user";
const FALLBACK_DISPLAY_NAME = "Cognito User";

/** CognitoのIDトークンに含まれるクレーム。フェデレーション経路によって欠ける項目があるため個別に検証する。 */
export type IdTokenClaims = Readonly<Record<string, unknown>>;

function stringClaim(claims: IdTokenClaims, key: string): string | undefined {
  const value = claims[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * IDトークンのクレームから表示用ユーザーを作る。
 *
 * Cognitoの`GetUser`API（Amplifyの`fetchUserAttributes`）は使わない。あのAPIはアクセストークンに
 * `aws.cognito.signin.user.admin`スコープを要求するが、Hosted UI経由のAuthorization Code Flowでは
 * App Clientに許可したスコープしか付与されないため、Entraフェデレーションでログインすると
 * `Access Token does not have required scopes`で失敗する。IDトークンのクレームなら追加スコープも
 * 追加のネットワーク往復も要らない。
 */
export function userViewFromIdTokenClaims(claims: IdTokenClaims | undefined): UserView {
  if (!claims) throw new Error("認証セッションがありません。再度ログインしてください。");
  return {
    id: stringClaim(claims, "sub") ?? FALLBACK_USER_ID,
    tenantId: TENANT_ID,
    displayName: stringClaim(claims, "name") ?? stringClaim(claims, "email") ?? FALLBACK_DISPLAY_NAME,
    roles: [],
  };
}
