/**
 * 本文チャンネルへ漏れた`<reasoning>`タグを思考チャンネルへ振り分ける。
 *
 * GPT-OSSは通常、思考を`reasoningContent`ブロックで返す。しかし稀に、本文のtextDelta側へ
 * `<reasoning>...</reasoning>`という素のタグごと思考を出すことがある。フロントエンドは生HTMLを
 * 描画しないため、これがそのまま文字列として本文に表示される。
 *
 * デルタは任意の位置で分割されるため、タグの前半だけが届く場合がある。確定できない末尾は
 * 保留し、続きが来てから判定する。`flush()`で保留分を吐き出す。
 */

const OPEN_TAG = "<reasoning>";
const CLOSE_TAG = "</reasoning>";

export type TaggedSegment = { channel: "text" | "reasoning"; text: string };

/** 末尾がタグの前半になりうる長さ。次のデルタを待つために保留する。 */
function heldBackLength(buffer: string, tag: string): number {
  const max = Math.min(buffer.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (tag.startsWith(buffer.slice(buffer.length - length))) return length;
  }
  return 0;
}

export class ReasoningTagSplitter {
  #buffer = "";
  #inReasoning = false;

  /** デルタを受け取り、確定した分だけをチャンネル別に返す。 */
  push(delta: string): TaggedSegment[] {
    this.#buffer += delta;
    const segments: TaggedSegment[] = [];

    for (;;) {
      const tag = this.#inReasoning ? CLOSE_TAG : OPEN_TAG;
      const index = this.#buffer.indexOf(tag);
      if (index === -1) break;
      const before = this.#buffer.slice(0, index);
      if (before) segments.push({ channel: this.#inReasoning ? "reasoning" : "text", text: before });
      this.#buffer = this.#buffer.slice(index + tag.length);
      this.#inReasoning = !this.#inReasoning;
    }

    const pendingTag = this.#inReasoning ? CLOSE_TAG : OPEN_TAG;
    const hold = heldBackLength(this.#buffer, pendingTag);
    const ready = this.#buffer.slice(0, this.#buffer.length - hold);
    this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
    if (ready) segments.push({ channel: this.#inReasoning ? "reasoning" : "text", text: ready });
    return segments;
  }

  /** 残った保留分を確定させる。タグが閉じないまま終わった場合も取りこぼさない。 */
  flush(): TaggedSegment[] {
    if (!this.#buffer) return [];
    const segment: TaggedSegment = { channel: this.#inReasoning ? "reasoning" : "text", text: this.#buffer };
    this.#buffer = "";
    return [segment];
  }
}
