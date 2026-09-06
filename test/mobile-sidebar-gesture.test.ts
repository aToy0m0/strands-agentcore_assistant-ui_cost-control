import { describe, expect, it } from "vitest";
import { isMobileSidebarOpeningSwipe } from "../src/lib/mobile-sidebar-gesture.js";

describe("isMobileSidebarOpeningSwipe", () => {
  it("opens for a deliberate right swipe from the mobile left area", () => {
    expect(isMobileSidebarOpeningSwipe({ x: 60, y: 300 }, { x: 150, y: 315 }, 390)).toBe(true);
  });

  it.each([
    ["desktop", { x: 20, y: 300 }, { x: 140, y: 300 }, 1024],
    ["outside the opening area", { x: 100, y: 300 }, { x: 200, y: 300 }, 390],
    ["too short", { x: 20, y: 300 }, { x: 80, y: 300 }, 390],
    ["leftward", { x: 60, y: 300 }, { x: 0, y: 300 }, 390],
    ["vertical scroll", { x: 20, y: 200 }, { x: 100, y: 280 }, 390],
  ])("ignores %s gestures", (_name, start, end, viewportWidth) => {
    expect(isMobileSidebarOpeningSwipe(start, end, viewportWidth)).toBe(false);
  });
});
