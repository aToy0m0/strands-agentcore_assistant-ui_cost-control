import { describe, expect, it } from "vitest";
import { validateNewPassword } from "../src/lib/new-password.js";

describe("validateNewPassword", () => {
  it("accepts matching passwords with at least 12 characters", () => {
    expect(validateNewPassword("Example-1234", "Example-1234")).toBeUndefined();
  });

  it("rejects a short password", () => {
    expect(validateNewPassword("Short-1", "Short-1")).toBe("新しいパスワードは12文字以上で入力してください。");
  });

  it("rejects a mismatched confirmation", () => {
    expect(validateNewPassword("Example-1234", "Different-1234")).toBe("新しいパスワードが一致しません。");
  });
});
