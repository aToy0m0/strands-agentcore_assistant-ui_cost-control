import { describe, expect, it } from "vitest";
import { resolveLoginMethods, showsCognitoLogin, showsEntraLogin } from "../shared/login-methods.js";

describe("resolveLoginMethods", () => {
  it("未指定かつEntra無効ならCognitoのみを既定にする", () => {
    expect(resolveLoginMethods(undefined, false)).toBe("cognito");
  });

  it("未指定かつEntra有効なら両方を既定にする", () => {
    expect(resolveLoginMethods(undefined, true)).toBe("cognito-and-entra");
  });

  it("指定された値をそのまま採用する", () => {
    expect(resolveLoginMethods("cognito", true)).toBe("cognito");
    expect(resolveLoginMethods("entra", true)).toBe("entra");
    expect(resolveLoginMethods("cognito-and-entra", true)).toBe("cognito-and-entra");
  });

  it("Entra無効のままEntra表示を求めれば拒否する", () => {
    expect(() => resolveLoginMethods("entra", false)).toThrow("requires entraEnabled=true");
    expect(() => resolveLoginMethods("cognito-and-entra", false)).toThrow("requires entraEnabled=true");
  });

  it("Entra無効でもCognitoのみなら許可する", () => {
    expect(resolveLoginMethods("cognito", false)).toBe("cognito");
  });

  it("未知の値は拒否する", () => {
    expect(() => resolveLoginMethods("saml", true)).toThrow("loginMethods must be one of");
    expect(() => resolveLoginMethods(true, true)).toThrow("loginMethods must be one of");
  });
});

describe("showsCognitoLogin / showsEntraLogin", () => {
  it("cognitoではパスワード欄だけを出す", () => {
    expect(showsCognitoLogin("cognito")).toBe(true);
    expect(showsEntraLogin("cognito")).toBe(false);
  });

  it("entraではMicrosoftボタンだけを出す", () => {
    expect(showsCognitoLogin("entra")).toBe(false);
    expect(showsEntraLogin("entra")).toBe(true);
  });

  it("cognito-and-entraでは両方を出す", () => {
    expect(showsCognitoLogin("cognito-and-entra")).toBe(true);
    expect(showsEntraLogin("cognito-and-entra")).toBe(true);
  });
});
