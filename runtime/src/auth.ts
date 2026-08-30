type JwtClaims = { sub?: unknown; "cognito:groups"?: unknown };

const LIMIT_GROUP_PREFIX = "workmate-limit-";

export class AuthenticationError extends Error {}

export function actorIdFromAuthorization(authorization: string | undefined): string {
  return identityFromAuthorization(authorization).actorId;
}

export function identityFromAuthorization(authorization: string | undefined): { actorId: string; limitProfileId?: string } {
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization ?? "");
  if (!match) throw new AuthenticationError("Authorization bearer token is required");
  const parts = match[1].split(".");
  if (parts.length !== 3) throw new AuthenticationError("Authorization bearer token is malformed");
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtClaims;
    if (typeof claims.sub !== "string" || !claims.sub.trim()) throw new AuthenticationError("Authorization token sub claim is required");
    if (claims["cognito:groups"] !== undefined && (!Array.isArray(claims["cognito:groups"]) || !claims["cognito:groups"].every((group) => typeof group === "string"))) {
      throw new AuthenticationError("Authorization token cognito:groups claim is malformed");
    }
    const limitGroups = (claims["cognito:groups"] ?? [])
      .filter((group): group is string => typeof group === "string" && group.startsWith(LIMIT_GROUP_PREFIX));
    if (limitGroups.length > 1) throw new AuthenticationError("Authorization token contains multiple user limit profiles");
    const limitProfileId = limitGroups[0]?.slice(LIMIT_GROUP_PREFIX.length);
    if (limitProfileId === "") throw new AuthenticationError("Authorization token contains an invalid user limit profile");
    return { actorId: claims.sub, ...(limitProfileId === undefined ? {} : { limitProfileId }) };
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("Authorization bearer token payload is malformed");
  }
}
