type JwtClaims = { sub?: unknown };

export class AuthenticationError extends Error {}

export function actorIdFromAuthorization(authorization: string | undefined): string {
  return identityFromAuthorization(authorization).actorId;
}

export function identityFromAuthorization(authorization: string | undefined): { actorId: string } {
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization ?? "");
  if (!match) throw new AuthenticationError("Authorization bearer token is required");
  const parts = match[1].split(".");
  if (parts.length !== 3) throw new AuthenticationError("Authorization bearer token is malformed");
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtClaims;
    if (typeof claims.sub !== "string" || !claims.sub.trim()) throw new AuthenticationError("Authorization token sub claim is required");
    return { actorId: claims.sub };
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("Authorization bearer token payload is malformed");
  }
}
