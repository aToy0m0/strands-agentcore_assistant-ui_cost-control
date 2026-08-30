import { describe, expect, it } from "vitest";
import { assignedUserLimitProfile, parseUserLimitProfiles, userLimitWindowKey } from "../../shared/user-limit-profiles.js";

describe("user limit profiles", () => {
  const profiles = parseUserLimitProfiles(JSON.stringify([
    { id: "default", default: true, window: "monthly", tokenLimit: 1_000_000 },
    { id: "daily", default: false, window: "daily", tokenLimit: 50_000 },
  ]));

  it("未割り当てユーザーへ既定プロファイルを適用する", () => {
    expect(assignedUserLimitProfile(profiles, undefined).id).toBe("default");
  });

  it("未知の割り当ては既定へフォールバックせず拒否する", () => {
    expect(() => assignedUserLimitProfile(profiles, "missing")).toThrow("unknown user limit profile");
  });

  it("UTCの日次・週次・月次ウィンドウを計算する", () => {
    const sunday = new Date("2026-08-30T23:59:59Z");
    expect(userLimitWindowKey("daily", sunday)).toBe("2026-08-30");
    expect(userLimitWindowKey("weekly", sunday)).toBe("2026-08-24");
    expect(userLimitWindowKey("monthly", sunday)).toBe("2026-08");
  });

  it("既定が複数ある設定を拒否する", () => {
    expect(() => parseUserLimitProfiles(JSON.stringify([
      { id: "one", default: true, window: "daily", tokenLimit: 1 },
      { id: "two", default: true, window: "daily", tokenLimit: 1 },
    ]))).toThrow("exactly one default");
  });
});
