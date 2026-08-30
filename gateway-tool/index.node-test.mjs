import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "./index.mjs";

test("returns a configured support contact", async () => {
  await assert.doesNotReject(async () => {
    assert.deepEqual(await handler({ department: " Support " }), {
      department: "support",
      email: "support@example.com",
      hours: "平日 09:00-18:00 JST",
    });
  });
});

test("rejects an unknown department", async () => {
  await assert.rejects(() => handler({ department: "engineering" }), /sales, support, billing/u);
});
