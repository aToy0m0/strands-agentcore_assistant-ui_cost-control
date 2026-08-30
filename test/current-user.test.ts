import { describe, expect, it } from "vitest";
import { userViewFromIdTokenClaims } from "../src/lib/current-user.js";

describe("userViewFromIdTokenClaims", () => {
  it("nameクレームを表示名に使う", () => {
    expect(userViewFromIdTokenClaims({ sub: "user-1", name: "山田 太郎", email: "taro@example.com" })).toEqual({
      id: "user-1",
      tenantId: "cognito",
      displayName: "山田 太郎",
      roles: [],
    });
  });

  it("nameがないときはemailを表示名に使う", () => {
    expect(userViewFromIdTokenClaims({ sub: "user-2", email: "hanako@example.com" }).displayName).toBe("hanako@example.com");
  });

  it("Entraフェデレーションでnameもemailも欠ける場合は既定の表示名にする", () => {
    expect(userViewFromIdTokenClaims({ sub: "user-3" })).toEqual({
      id: "user-3",
      tenantId: "cognito",
      displayName: "Cognito User",
      roles: [],
    });
  });

  it("文字列以外や空文字のクレームは無視する", () => {
    expect(userViewFromIdTokenClaims({ sub: "user-4", name: "", email: 42 }).displayName).toBe("Cognito User");
  });

  it("subが欠ける場合は既定のIDにする", () => {
    expect(userViewFromIdTokenClaims({ email: "noid@example.com" }).id).toBe("cognito-user");
  });

  it("クレームがない場合は再ログインを促すエラーにする", () => {
    expect(() => userViewFromIdTokenClaims(undefined)).toThrowError("認証セッションがありません。再度ログインしてください。");
  });
});
