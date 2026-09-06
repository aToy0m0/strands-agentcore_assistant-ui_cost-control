import { describe, expect, it } from "vitest";
import { resolveAppViewport } from "../src/lib/visual-viewport.js";

describe("resolveAppViewport", () => {
  it("iPhoneのソフトウェアキーボードで狭くなった表示領域を返す", () => {
    expect(resolveAppViewport(844, { height: 467.4, offsetTop: 3.2 }, true)).toEqual({
      height: 467,
      offsetTop: 3,
      keyboardOpen: true,
    });
  });

  it("アドレスバー程度の差はキーボードと判定しない", () => {
    expect(resolveAppViewport(844, { height: 730, offsetTop: 0 }, true).keyboardOpen).toBe(false);
  });

  it("Visual Viewport非対応ブラウザではレイアウト高を使う", () => {
    expect(resolveAppViewport(900)).toEqual({ height: 900, offsetTop: 0, keyboardOpen: false });
  });
});
