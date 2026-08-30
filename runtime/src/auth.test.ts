import { describe, expect, it } from "vitest";
import { actorIdFromAuthorization, AuthenticationError, identityFromAuthorization } from "./auth.js";

function token(claims: unknown): string {
  return `Bearer header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

describe("actorIdFromAuthorization", () => {
  it("uses the authenticated subject as actorId", () => {
    expect(actorIdFromAuthorization(token({ sub: "cognito-user-sub" }))).toBe("cognito-user-sub");
  });

  it("上限プロファイル用Cognitoグループを取得する", () => {
    expect(identityFromAuthorization(token({ sub: "user-1", "cognito:groups": ["other", "workmate-limit-weekly"] })))
      .toEqual({ actorId: "user-1", limitProfileId: "weekly" });
  });

  it("複数の上限プロファイル割り当てを拒否する", () => {
    expect(() => identityFromAuthorization(token({ sub: "user-1", "cognito:groups": ["workmate-limit-weekly", "workmate-limit-daily"] })))
      .toThrow(AuthenticationError);
  });

  it.each([undefined, "Basic abc", "Bearer malformed", token({})])("rejects an unusable token: %s", (authorization) => {
    expect(() => actorIdFromAuthorization(authorization)).toThrow(AuthenticationError);
  });
});
