import { describe, expect, it } from "vitest";
import { ReasoningTagSplitter, type TaggedSegment } from "./reasoning-tags.js";

function feed(deltas: readonly string[]): TaggedSegment[] {
  const splitter = new ReasoningTagSplitter();
  return [...deltas.flatMap((delta) => splitter.push(delta)), ...splitter.flush()];
}

function joined(segments: readonly TaggedSegment[], channel: TaggedSegment["channel"]): string {
  return segments.filter((segment) => segment.channel === channel).map((segment) => segment.text).join("");
}

describe("ReasoningTagSplitter", () => {
  it("タグがなければすべて本文として返す", () => {
    expect(feed(["こんにちは", "世界"])).toEqual([
      { channel: "text", text: "こんにちは" },
      { channel: "text", text: "世界" },
    ]);
  });

  it("1つのデルタに収まったタグを思考へ振り分ける", () => {
    const segments = feed(["前<reasoning>考え中</reasoning>後"]);
    expect(joined(segments, "text")).toBe("前後");
    expect(joined(segments, "reasoning")).toBe("考え中");
  });

  it("タグがデルタ境界で分割されても取りこぼさない", () => {
    const segments = feed(["前<reas", "oning>考え", "中</reason", "ing>後"]);
    expect(joined(segments, "text")).toBe("前後");
    expect(joined(segments, "reasoning")).toBe("考え中");
  });

  it("1文字ずつ届いても復元できる", () => {
    const source = "A<reasoning>B</reasoning>C";
    const segments = feed([...source]);
    expect(joined(segments, "text")).toBe("AC");
    expect(joined(segments, "reasoning")).toBe("B");
  });

  it("閉じタグがないまま終わっても内容を失わない", () => {
    const segments = feed(["本文<reasoning>途中で終了"]);
    expect(joined(segments, "text")).toBe("本文");
    expect(joined(segments, "reasoning")).toBe("途中で終了");
  });

  it("タグの前半に見える文字列は確定するまで本文として出さない", () => {
    const splitter = new ReasoningTagSplitter();
    expect(splitter.push("結果は<re")).toEqual([{ channel: "text", text: "結果は" }]);
    expect(splitter.push("d>です")).toEqual([{ channel: "text", text: "<red>です" }]);
  });

  it("複数回の出現を扱える", () => {
    const segments = feed(["a<reasoning>1</reasoning>b<reasoning>2</reasoning>c"]);
    expect(joined(segments, "text")).toBe("abc");
    expect(joined(segments, "reasoning")).toBe("12");
  });
});
