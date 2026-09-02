# Runtime機能一覧

この資料は、AgentCore CodeZip Runtimeに実装されている機能と、その責務・制約を説明します。対象は主に`runtime/src/`、`shared/`、`gateway-tool/`、`infrastructure/stack.ts`です。

## Runtimeの役割

Runtimeはブラウザから受け取ったAG-UIリクエストを認証ユーザーの処理として実行し、Bedrockモデル、AgentCore Memory、AgentCore Gatewayを組み合わせて応答します。

```text
Browser
  └─ POST /invocations（Cognito Access Token）
       └─ AgentCore Runtime
            ├─ Bedrockモデルをストリーミング実行
            ├─ AgentCore Memoryから履歴・個人メモリを取得
            ├─ 組み込みツールを実行
            ├─ Bedrock Knowledge Baseを検索
            ├─ AgentCore Gateway経由でLambdaツールを実行
            └─ AG-UI SSEイベントをBrowserへ返す
```

## 実装済み機能

| 分類 | 機能 | 実装内容 |
|---|---|---|
| HTTP | ヘルスチェック | `GET /ping`が`Healthy`を返す |
| HTTP | エージェント実行 | `POST /invocations`でAG-UIの`RunAgentInput`を受け付ける |
| 認証 | ユーザー識別 | AgentCoreで検証されたBearer JWTの`sub`を`actorId`として使用 |
| ストリーミング | AG-UI SSE | 実行開始、思考、本文、ツール、割り込み、完了、エラーをイベント送信 |
| モデル | Bedrock推論 | 選択モデルとReasoning設定をリクエストごとに検証・適用 |
| 履歴 | 短期記憶 | ユーザー発言とアシスタント回答をターン単位でAgentCore Memoryへ保存 |
| 履歴 | 会話復元 | スレッド一覧、メッセージ一覧をMemoryから取得し、過去の会話をモデルへ渡す |
| 履歴 | 会話削除 | 対象スレッドのMemoryイベントを削除 |
| 個人メモリ | 長期記憶検索 | ユーザー固有の事実と好みを意味検索し、システムプロンプトへ追加 |
| ツール | 組み込みツール | 計算、日時、文字統計、ユーザーへの確認を提供 |
| ツール | Knowledge Base検索 | デプロイ時に指定したKnowledge Baseへ`Retrieve`を実行し、本文と出典を返す |
| ツール | Gateway連携 | Cognitoトークンを引き継ぎ、MCPでGatewayターゲットを利用 |
| Human in the loop | 実行中断と再開 | `ask_user`で実行を中断し、AG-UIのresume入力で同じAgentを再開 |
| ログ | 構造化ログ | request、model、tool、errorを1行JSONで出力 |
| キャンセル | 実行停止 | HTTP切断をAbortSignalへ変換し、進行中のモデル実行へ通知 |

## AG-UIイベント変換

`runtime/src/app.ts`と`runtime/src/stream-events.ts`が、StrandsのイベントをAG-UIへ変換します。

| Runtime内の状態 | AG-UIイベント |
|---|---|
| 実行開始 | `RUN_STARTED` |
| Reasoning開始・差分・終了 | `REASONING_START`、`REASONING_MESSAGE_*`、`REASONING_END` |
| 回答本文 | `TEXT_MESSAGE_START`、`TEXT_MESSAGE_CONTENT`、`TEXT_MESSAGE_END` |
| ツール呼び出し | `TOOL_CALL_START`、`TOOL_CALL_ARGS`、`TOOL_CALL_END` |
| ツール結果 | `TOOL_CALL_RESULT` |
| ユーザー入力待ち | `RUN_FINISHED`のinterrupt outcome |
| 正常終了 | `RUN_FINISHED` |
| 実行失敗 | `RUN_ERROR` |

本文、思考、ツールを出力順に表示できるよう、本文区間ごとにメッセージIDを分けます。内部例外の詳細はブラウザへ返さず、Runtimeログに記録してUIへは一般化したエラーを返します。

## 対応モデル

モデル一覧は`shared/model-catalog.ts`をフロントエンドとRuntimeで共有し、UI表示とRuntime検証の二重管理を避けています。

| 表示名 | プロバイダー | Reasoning | 入力token計数 | 制限方式 |
|---|---|---|---|---|
| Amazon Nova 2 Lite | Amazon | ON/OFF、Low・Medium・High | 応答usage | ソフト |
| Claude Haiku 4.5 | Anthropic | ON/OFF、Low・Medium・High | 応答usage | ソフト |
| Claude Sonnet 4.6 | Anthropic | ON/OFF、Low・Medium・High | 応答usage | ソフト |
| Claude Sonnet 5 | Anthropic | 常時ON、Low・Medium・High | 応答usage | ソフト |
| GPT-OSS 20B | OpenAI | 常時ON、Low・Medium・High | 応答usage | ソフト |
| GPT-OSS 120B | OpenAI | 常時ON、Low・Medium・High | 応答usage | ソフト |
| GLM 4.7 Flash | Z.AI | ON/OFF | 応答usage | ソフト |
| GLM 4.7 | Z.AI | ON/OFF | 応答usage | ソフト |

Runtimeは未知のモデル、未対応のEffort、余分な推論設定フィールドをエラーにします。全8モデルは最大出力だけを事前予約し、入力分を応答usageで加算するソフト制限です。受け付けた1回の呼び出しで上限を超える可能性があります。

## ユーザー単位のトークン上限

Cognitoアクセストークンの`cognito:groups`にある`workmate-limit-<profileID>`から割り当てを確定します。未所属だけは既定プロファイルを使用し、複数所属・未知のプロファイルは拒否します。各LLM呼び出し前に`maxOutputTokens`をユーザー枠から原子的に予約し、完了後にBedrock usageの`inputTokens + outputTokens`で精算します。未計数の入力分だけ実績が予約を上回る場合があります。

ウィンドウはUTCの日次、月曜開始の週次、月次です。プロファイル変更後は再ログインが必要です。

## 短期記憶とチャット履歴

短期記憶はAgentCore Memoryのイベントとして保存します。

- `actorId`: Cognito Access Tokenの`sub`
- `sessionId`: UIのチャットID
- 1イベント: ユーザー発言とアシスタント回答の組
- 保持期間: CDKの既定で30日
- まだイベントを保存していない新規ユーザーはAgentCore Memory上にActorが存在しないため、`Actor not found`を履歴0件として扱う
- 一覧表示: 新しい順に最大50スレッド
- タイトル: 最初のユーザー発言から最大40文字

保存するのは正常に完了したターンです。実行中断中のターンは、ユーザーの回答を受けて完了した時点で保存します。会話削除はスレッドに含まれるイベントを列挙して削除します。

## 長期記憶

AgentCore MemoryのManaged Memory Strategyを利用します。

| 種別 | Namespace | 用途 |
|---|---|---|
| 個人の事実 | `/workmate/{actorId}/facts` | 居住地、所属など継続利用できる事実 |
| ユーザーの好み | `/workmate/{actorId}/preferences` | 回答形式や表現などの好み |

新しい通常リクエストでは、入力文を検索語として各Namespaceから最大5件を取得します。重複を除き、合計8,000文字以内でシステムプロンプトへ追加します。取得したメモリは命令ではなく信頼できない参考データとして扱うよう、プロンプトで明示しています。

## ツール

### 組み込みツール

| ツール名 | 機能 | 主な入力制約 |
|---|---|---|
| `calculator` | 加算、減算、乗算、除算 | 有限数のみ、ゼロ除算と無限大結果を拒否 |
| `current_datetime` | 現在日時とタイムゾーン変換 | 有効なIANAタイムゾーンのみ |
| `text_statistics` | 文字、単語、行、バイト数などを集計 | 最大100,000 UTF-16コード単位、有効なlocaleのみ |
| `ask_user` | 不足情報をユーザーへ質問 | 質問500文字、選択肢2～6件、自由入力可否を指定可能 |
| `search_knowledge_base` | 既存Knowledge Baseの意味検索 | 検索語1～1,000文字、取得件数1～10件（既定5件） |

`search_knowledge_base`はRuntimeのAWS認証情報を使ってBedrock `Retrieve` APIを直接呼びます。結果にはKnowledge Base ID、本文、スコア、文書ID、メタデータ、出典位置を含めます。0件は正常結果として返し、AWS API失敗は成功結果へ置き換えず、Knowledge Base ID、AWSエラー名、取得できた場合はリクエストIDを含むエラーにします。

### Gatewayツール

Runtimeは`McpClient`でAgentCore Gatewayへ接続します。ブラウザから受け取ったCognitoトークンをGatewayへ渡すため、Gateway側でも同じ認証ユーザーとして検証されます。

現在のGatewayターゲットは`SupportDirectory___lookup_support_contact`です。`sales`、`support`、`billing`の問い合わせ先と営業時間をLambdaから返します。Lambda側でも入力値を検証します。

## Human in the loop

`ask_user`が呼ばれると、StrandsのinterruptをAG-UIのinterrupt outcomeへ変換します。UIからresume入力が届くと、interrupt IDと回答を`InterruptResponseContent`へ変換して同じAgent処理を再開します。

中断中のAgent、Gateway接続、途中までの回答はRuntimeプロセス内のMapへ一時保持します。このため、Runtime再起動、プロセス消失、別インスタンスへのルーティングをまたぐ永続的な再開は保証しません。未回答のまま同じスレッドで新しい通常実行を始めることも拒否します。

これは既知の不具合です。AgentCore Runtimeのアイドルタイムアウトは300秒であり、回答待ちの間にRuntimeが終了すると、再開時に`Interrupted agent state is unavailable; start the request again`となり、UIには`AGENT_INVOCATION_FAILED`が表示されます。AgentCore Memoryは会話履歴と個人メモリを保存しますが、Strands内部のinterrupt状態は保存しません。根本対応には、StrandsのSession Managerと永続ストレージによる中断状態の保存・復元が必要です。

## ログとエラー処理

- `request`: 受信メッセージと実行識別子
- `model`: 回答、Reasoning文字数、処理時間
- `tool`: ツール名、引数、結果
- `error`: 失敗メッセージとスタック

request、model、toolはCDKコンテキストから個別に無効化できます。errorは障害調査のため常時出力します。ログ本文には利用者の入力や回答、ツール引数・結果が含まれるため、機密情報を扱う環境ではログ設定とアクセス制御を見直します。

## 対象外・制約

- BFF、独自セッションDB、RDSは使用しません。DynamoDBはLLM費用台帳にだけ使用します。
- プロジェクト単位のMemory分離は実装していません。
- チャット名、ピン留め、アーカイブ、プロジェクト、フィードバックはRuntimeへ保存しません。
- 添付ファイルの内容をRuntimeで永続保存しません。
- Human in the loopの中断状態は永続化しません。
- Gatewayツールの追加は自動検出ではなく、GatewayターゲットとIAMをCDKで定義する必要があります。

## 主な実装ファイル

| ファイル | 責務 |
|---|---|
| `runtime/src/main.ts` | Agent、Memory、Gateway、interrupt再開の統合 |
| `runtime/src/app.ts` | HTTP、認証、履歴操作、AG-UI SSE |
| `runtime/src/memory.ts` | 短期履歴と長期記憶 |
| `runtime/src/knowledge-base.ts` | Bedrock Knowledge Base検索ツール |
| `runtime/src/model-factory.ts` | モデルごとのBedrock設定 |
| `runtime/src/stream-events.ts` | StrandsからAG-UIへのイベント変換 |
| `runtime/src/tools.ts` | 組み込みツールと`ask_user` |
| `runtime/src/logging.ts` | 構造化ログ |
| `gateway-tool/index.mjs` | 問い合わせ先検索Lambda |
| `shared/model-catalog.ts` | モデル定義と推論設定検証 |
