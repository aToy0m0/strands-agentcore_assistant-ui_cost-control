import { describe, expect, it } from "vitest";
import { remarkHtmlLineBreak } from "../src/lib/remark-html-line-break.js";

const transform = remarkHtmlLineBreak();

function html(value: string) {
  return { type: "html", value };
}

describe("remarkHtmlLineBreak", () => {
  it("brタグを改行ノードへ置き換える", () => {
    const tree = { type: "root", children: [{ type: "paragraph", children: [html("<br>")] }] };
    expect(transform(tree)).toEqual({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "break" }] }],
    });
  });

  it("自己終了形と大文字と余白も改行として扱う", () => {
    for (const value of ["<br/>", "<br />", "<BR>", "  <br>  "]) {
      const tree = { type: "root", children: [html(value)] };
      expect(transform(tree).children?.[0]).toEqual({ type: "break" });
    }
  });

  it("br以外のタグはHTMLノードのまま残す", () => {
    for (const value of ["<script>", "<div>", "<img src=x onerror=alert(1)>", "<br-fake>"]) {
      const tree = { type: "root", children: [html(value)] };
      expect(transform(tree).children?.[0]).toEqual(html(value));
    }
  });

  it("入れ子の表セル内でも置き換える", () => {
    const tree = {
      type: "root",
      children: [{
        type: "table",
        children: [{ type: "tableRow", children: [{ type: "tableCell", children: [{ type: "text", value: "36" }, html("<br>"), { type: "text", value: "360" }] }] }],
      }],
    };
    const cell = transform(tree).children?.[0]?.children?.[0]?.children?.[0];
    expect(cell?.children).toEqual([{ type: "text", value: "36" }, { type: "break" }, { type: "text", value: "360" }]);
  });

  it("元のツリーを書き換えない", () => {
    const original = { type: "root", children: [html("<br>")] };
    transform(original);
    expect(original.children[0]).toEqual(html("<br>"));
  });
});
