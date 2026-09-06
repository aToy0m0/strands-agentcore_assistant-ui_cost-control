import { describe, expect, it } from "vitest";
import { actorIdFromAuthorization, AuthenticationError, identityFromAuthorization } from "./auth.js";

function token(claims: unknown): string {
  return `Bearer header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

describe("actorIdFromAuthorization", () => {
  it("uses the authenticated subject as actorId", () => {
    expect(actorIdFromAuthorization(token({ sub: "cognito-user-sub" }))).toBe("cognito-user-sub");
  });

  it("Cognitoグループは費用上限の判定に使わない", () => {
    expect(identityFromAuthorization(token({ sub: "user-1", "cognito:groups": ["other"] })))
      .toEqual({ actorId: "user-1" });
  });

  it.each([undefined, "Basic abc", "Bearer malformed", token({})])("rejects an unusable token: %s", (authorization) => {
    expect(() => actorIdFromAuthorization(authorization)).toThrow(AuthenticationError);
  });
});
