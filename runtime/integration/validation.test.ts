import { beforeAll, describe, expect, it, vi } from "vitest";

const tenantId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";
vi.mock("@/server/auth/context", () => ({
  getAuthContext: vi.fn(async () => ({ tenantId, userId, displayName: "Integration User" })),
}));

describe("BFF input validation", () => {
  beforeAll(() => {
    process.env.APP_ENV = "local";
    process.env.APP_AUTH_MODE = "local";
    process.env.LOCAL_TENANT_ID = tenantId;
    process.env.LOCAL_USER_ID = userId;
  });

  it("returns 400 for an invalid project memory mode", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const response = await POST(new Request("http://localhost/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test", icon: "folder", color: "#000000", memoryMode: "INVALID" }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_BODY" });
  });

  it("returns 400 before Prisma receives an invalid path UUID", async () => {
    const { GET } = await import("@/app/api/projects/[projectId]/route");
    const response = await GET(new Request("http://localhost/api/projects/not-a-uuid"), {
      params: Promise.resolve({ projectId: "not-a-uuid" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_ID" });
  });
});
