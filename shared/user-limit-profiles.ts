export type UserLimitWindow = "daily" | "weekly" | "monthly";

export type UserLimitProfile = {
  id: string;
  default: boolean;
  window: UserLimitWindow;
  tokenLimit: number;
};

export const DEFAULT_USER_LIMIT_PROFILES: readonly UserLimitProfile[] = [
  { id: "default", default: true, window: "monthly", tokenLimit: 1_000_000 },
];

export function parseUserLimitProfiles(configured: unknown): readonly UserLimitProfile[] {
  const source = configured === undefined || configured === null
    ? DEFAULT_USER_LIMIT_PROFILES
    : parseJson(configured);
  if (!Array.isArray(source) || source.length === 0 || source.length > 20) {
    throw new Error("userLimitProfiles must contain between 1 and 20 profiles");
  }
  const profiles = source.map((item, index) => parseProfile(item, index));
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error("userLimitProfiles profile IDs must be unique");
  }
  if (profiles.filter((profile) => profile.default).length !== 1) {
    throw new Error("userLimitProfiles must contain exactly one default profile");
  }
  return profiles;
}

export function defaultUserLimitProfile(profiles: readonly UserLimitProfile[]): UserLimitProfile {
  const profile = profiles.find((candidate) => candidate.default);
  if (!profile) throw new Error("default user limit profile is unavailable");
  return profile;
}

export function assignedUserLimitProfile(profiles: readonly UserLimitProfile[], profileId: string | undefined): UserLimitProfile {
  if (profileId === undefined) return defaultUserLimitProfile(profiles);
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`unknown user limit profile: ${profileId}`);
  return profile;
}

export function userLimitWindowKey(window: UserLimitWindow, date = new Date()): string {
  if (Number.isNaN(date.getTime())) throw new Error("invalid date");
  if (window === "monthly") return `${date.getUTCFullYear()}-${twoDigits(date.getUTCMonth() + 1)}`;
  if (window === "daily") return `${date.getUTCFullYear()}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())}`;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const daysSinceMonday = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return `${monday.getUTCFullYear()}-${twoDigits(monday.getUTCMonth() + 1)}-${twoDigits(monday.getUTCDate())}`;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("userLimitProfiles must be a JSON string");
  if (value.length > 3_000) throw new Error("userLimitProfiles JSON is too large");
  try { return JSON.parse(value) as unknown; }
  catch { throw new Error("userLimitProfiles must be valid JSON"); }
}

function parseProfile(value: unknown, index: number): UserLimitProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`userLimitProfiles[${index}] must be an object`);
  const item = value as Record<string, unknown>;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u.test(String(item.id ?? ""))) {
    throw new Error(`userLimitProfiles[${index}].id must be a lowercase kebab-case ID of at most 48 characters`);
  }
  if (typeof item.default !== "boolean") throw new Error(`userLimitProfiles[${index}].default must be boolean`);
  if (item.window !== "daily" && item.window !== "weekly" && item.window !== "monthly") {
    throw new Error(`userLimitProfiles[${index}].window must be daily, weekly, or monthly`);
  }
  if (!Number.isSafeInteger(item.tokenLimit) || Number(item.tokenLimit) <= 0) {
    throw new Error(`userLimitProfiles[${index}].tokenLimit must be a positive safe integer`);
  }
  return { id: String(item.id), default: item.default, window: item.window, tokenLimit: Number(item.tokenLimit) };
}

function twoDigits(value: number): string { return String(value).padStart(2, "0"); }
