/**
 * Markdown中の`<br>`だけを改行として描画する。
 *
 * このアプリは`rehype-raw`を使わない。生HTMLを有効にするとXSSの経路になるためで、その結果
 * モデルが出力した`<br>`はリテラル文字列としてそのまま画面に出る。GPT-OSSは表のセル内改行に
 * `<br>`を使うため（Bedrockの実ストリームで確認済み）、表の中に`<br>`が見えてしまう。
 *
 * ここでは`<br>`に完全一致するHTMLノードだけをmdastの`break`ノードへ置き換える。
 * それ以外のタグはHTMLノードのまま残り、従来どおりリテラル表示される。生HTMLは有効化しない。
 */

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
};

const BR_ONLY = /^<br\s*\/?>$/i;

function replaceLineBreaks(node: MdastNode): MdastNode {
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.map((child) => (child.type === "html" && typeof child.value === "string" && BR_ONLY.test(child.value.trim())
      ? { type: "break" }
      : replaceLineBreaks(child))),
  };
}

export function remarkHtmlLineBreak() {
  return (tree: MdastNode): MdastNode => replaceLineBreaks(tree);
}
