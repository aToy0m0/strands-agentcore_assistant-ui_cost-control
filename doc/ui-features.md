# UI機能一覧

この資料は、React、assistant-ui、AG-UIで実装したブラウザ機能と、保存される状態・保存されない状態を説明します。対象は主に`src/`と`shared/`です。

## UIの役割

UIはCognitoで認証し、ブラウザからAgentCore Runtimeへ直接AG-UIリクエストを送ります。BFFやWeb API用Lambdaはありません。

公式のassistant-ui AG-UI Runtimeと同様に、`HttpAgent`を`useAgUiRuntime`へ渡し、AG-UIイベントからメッセージ、Reasoning、ツール呼び出し、実行状態を復元します。

## 実装済み機能

| 分類 | 機能 | 実装内容 |
|---|---|---|
| 認証 | Cognitoログイン | メールアドレスとパスワードでログイン |
| 認証 | 初回パスワード変更 | 管理者作成ユーザーが自分で新しいパスワードを設定 |
| 認証 | Microsoft Entra ID | CognitoのOIDC IdPを経由したリダイレクトログイン |
| 認証 | セッション更新 | 401/403時にAccess Tokenを更新して1回再試行 |
| 認証 | ログアウト | Cognitoセッションを終了 |
| チャット | ストリーミング表示 | AG-UI over SSEで回答を逐次表示 |
| チャット | Reasoning表示 | 思考区間を折りたたみカードとして表示 |
| チャット | ツール表示 | ツール名、入力、出力、エラー、実行状態を汎用カードで表示 |
| チャット | 履歴復元 | AgentCore Memoryから会話一覧とメッセージを復元 |
| チャット | 新規・切替・削除 | 複数チャットの作成、切替、Memory上の削除 |
| 編集 | メッセージ操作 | コピー、ユーザー発言の編集、分岐切替 |
| 実行 | 生成停止 | 実行中リクエストをキャンセル |
| 入力 | 添付 | 画像とテキストファイルをComposerへ添付 |
| 入力 | カメラ | ブラウザのカメラで撮影して画像添付 |
| 入力 | 音声入力 | Web Speech APIによる日本語の連続音声入力 |
| 出力 | Markdown | GFM対応Markdown、コード、リンクなどを表示 |
| 出力 | 音声読み上げ | Web Speech APIの読み上げAdapterを提供 |
| 推論 | モデル選択 | 8モデルから実行モデルを選択し、ハード／ソフト制限を表示 |
| 推論 | Reasoning設定 | ON/OFFと対応モデルのLow・Medium・Highを選択 |
| 推論 | 料金表示 | モデルごとの100万トークン単価を選択UIに表示 |
| 表示 | レスポンシブUI | デスクトップの開閉サイドバーとモバイルドロワー |
| 表示 | 没入表示 | サイドバーとヘッダーを隠してチャットへ集中 |
| 表示 | テーマ | システム、ライト、ダークを選択 |
| 表示 | 通知 | 認証、履歴、AG-UI、添付、カメラなどの結果をトースト表示 |
| 診断 | ブラウザデバッグ | デプロイ時にON/OFFを切り替え、HTTP・SSE・履歴・AG-UIイベントをConsoleへ出力 |

## 認証とRuntime接続

起動時に`/runtime-config.json`を取得し、CognitoとAgentCore Runtimeの接続先を確定します。設定が不足・不正な場合は初期化エラーとして停止し、別の値へフォールバックしません。

Cognitoが`CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED`を返した場合は、新しいパスワードと確認値の入力へ切り替え、Amplify `confirmSignIn`で初回チャレンジを完了します。12文字以上をUIでも検査し、英大文字・英小文字・数字・記号のUser PoolポリシーはCognitoの結果をそのままエラー表示します。「ログイン画面へ戻る」では未完了のサインイン状態を終了してから通常入力へ戻ります。

Runtime呼び出しでは次のヘッダーを付けます。

- `Authorization: Bearer <Cognito Access Token>`
- `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <threadId>`
- `Accept: text/event-stream`

401または403ではレスポンス本文を破棄し、AmplifyへAccess Tokenの強制更新を要求して1回だけ再送します。

## チャット画面

### メッセージ

- ユーザー発言とアシスタント回答を別レイアウトで表示
- アシスタント回答をMarkdownとして表示
- ユーザー発言とアシスタント回答をコピー
- ユーザー発言を編集して再送
- 分岐がある場合に前後の回答へ切り替え
- 実行エラーをメッセージ内とトーストで表示
- 長い会話で「一番下へ移動」を表示

### Reasoning

AG-UIのReasoningイベントを回答本文と分けて表示します。モデルが思考内容を公開しない場合は、Runtimeから「内容を考えています」「回答を作成しています」といった状態だけを受け取ります。

### ツール

ツールごとの専用コンポーネントを増やさず、すべて汎用のツールカードで表示します。

- ツール名
- 実行中、完了、失敗の状態
- JSON形式の引数
- JSON形式の結果
- エラー内容

組み込みツールとGatewayツールのどちらも同じ表示経路です。

## 入力機能

- 複数行テキスト入力
- 送信と生成停止
- 画像ファイルの添付
- テキストファイルの添付
- カメラ権限を利用した写真撮影と添付
- Web Speech API対応ブラウザでの日本語音声入力
- 添付の送信前確認と削除

カメラやマイクの利用拒否、非対応ブラウザ、読み込み失敗はトーストまたはダイアログ内で明示します。

## モデルとReasoning設定

モデル選択と推論設定は`useAui()`のmodel contextへ登録され、次のAG-UI実行リクエストから`forwardedProps.inference`として送信されます。

- 既定モデル: Claude Haiku 4.5
- 既定Reasoning: ON、Medium
- 任意Reasoningモデル: ON/OFFを選択
- 常時Reasoningモデル: UI上のOFFをRuntimeで最小Effortへ変換
- Effort非対応モデル: ON/OFFだけを表示

実行中はモデル設定ボタンを無効化し、同じ実行の途中で設定が変わらないようにします。

## 会話一覧

AgentCore Memoryから最大50件のチャットを読み込み、新しい順に表示します。

| 操作 | 動作 | 再読み込み後 |
|---|---|---|
| 新しいチャット | 新しいUUIDを作成 | 最初のターン完了後にMemoryへ現れる |
| チャット切替 | Memoryからメッセージを読み込む | 保持される |
| チャット削除 | Memoryイベントを削除 | 削除状態が保持される |
| 自動タイトル | 最初のユーザー発言から生成 | Memoryから再生成される |
| 名前変更 | UI内のタイトルを変更 | 保持されない |
| ピン留め | UI内のcustom状態を変更 | 保持されない |
| アーカイブ | UI内の表示区分を変更 | 保持されない |

## プロジェクトUI

プロジェクトの作成、名前変更、アイコン、色、メモリ方式、ピン留め、並び順、チャットの割り当て、共有リンクのコピーを操作できます。

ただし、このサンプルではプロジェクト情報をRuntimeやデータベースへ保存しません。すべてブラウザタブ内のReact stateです。`default`と`isolated`のメモリ方式もUI上の設定値であり、AgentCore MemoryのNamespaceや履歴分離には接続していません。再読み込みするとプロジェクトと割り当ては消えます。

## フィードバック

アシスタント回答に「良い回答」「改善が必要」の操作があります。現在は操作を受け付けて「保存されません」と通知するだけで、Runtimeや外部ストアへ送信しません。

## 設定画面

- 外観: システム、ライト、ダーク
- セッション: ログアウト
- 接続情報: Browser direct / CodeZip、Session ID、AG-UI over SSE、認証方式

テーマは`next-themes`で管理します。接続情報は診断用表示であり、画面から接続先ARNや認証設定を書き換える機能ではありません。

## 状態の保存境界

| 状態 | 保存先 | 永続性 |
|---|---|---|
| チャット本文 | AgentCore Memory短期記憶 | 既定30日 |
| 個人の事実・好み | AgentCore Memory長期記憶 | Memory Strategyにより管理 |
| チャット削除 | AgentCore Memoryイベント削除 | 永続 |
| 認証セッション | Cognito / Amplify | トークン有効期間に従う |
| 選択中のモデル・Reasoning | React state | 再読み込みで既定値へ戻る |
| チャット名・ピン・アーカイブ | assistant-uiの現在タブ内state | 再読み込みで消える |
| プロジェクトと割り当て | React state | 再読み込みで消える |
| フィードバック | 保存しない | 通知のみ |
| 添付ファイル | Composer内 | 送信・画面遷移後の永続保存なし |

## 観測されたAG-UIエラー表示

2026-08-25に、会話とツール実行が完了した後で次のトーストが表示される事象を確認しました。

```text
AG-UIエラー: Unexpected token 'd', "data: {"co"... is not valid JSON
```

確認できていること:

- 会話本文とツール利用は完了している。
- 同時間帯のRuntimeログに`Unexpected token`は記録されていない。
- 同時間帯のRuntimeログに`invocation.failed`は記録されていない。
- トーストは`useAgUiRuntime`の`onError`から`workmate-error`イベントを経由して表示される。
- 例外文字列はSSEの`data:`行をJSON本体として解析した場合の形式と一致する。

以上から、RuntimeやGatewayの処理失敗ではなく、ブラウザ側のSSEイベント解析またはストリーム終端処理で発生する表示上の問題である可能性が高い状態です。ただし、該当リクエストのブラウザNetworkレスポンスを未採取のため、二重SSE化、終端チャンク、クライアントライブラリのいずれが原因かは未確定です。

再調査時は、発生したリクエストのResponse Headers、レスポンス先頭と末尾、ブラウザConsole、発生時刻を採取し、`text/event-stream`と各`data:`行の境界を確認します。会話が完了したという理由だけでエラー通知を握りつぶす修正は行いません。

この調査のため、CDKコンテキスト`webDebugMode=on`でブラウザデバッグを有効化できます。ON時はAG-UIクライアント標準のevent／lifecycleログと、アプリ独自の`[Workmate debug]`ログをConsoleへ出します。設定画面の「接続」タブでも現在値を確認できます。既定はOFFで、`webDebugMode=off`を指定した再デプロイにより無効化できます。

`[Workmate debug]`のデータは整形済みJSON文字列で出力するため、DevTools上で`Object`へ折りたたまれず、そのままコピーできます。履歴APIがAgentCoreのSSEエラーを返した場合はContent-Typeを判定し、JSON解析エラーではなく`RUN_ERROR`のメッセージを表示します。

デバッグログはAuthorization、トークン、シークレット、パスワード、Base64添付をマスクします。ただし会話本文、履歴、ツール引数・結果、生のSSE本文は表示します。利用手順と注意事項は[デプロイ手順書の「ブラウザデバッグモード」](deployment-guide.md#ブラウザデバッグモード)を参照してください。

## 対象外・制約

- プロジェクト、ピン留め、名前変更、アーカイブの永続化
- プロジェクト単位のMemory分離
- フィードバック保存
- 添付ファイルの永続ストレージ
- 管理者画面、ユーザー管理画面（Cognitoユーザーと上限プロファイルはCLIで管理）
- ブラウザからのAWSリソース設定変更
- オフライン利用

## 主な実装ファイル

| ファイル | 責務 |
|---|---|
| `src/app.tsx` | 起動、Runtime設定取得、認証状態判定 |
| `src/config.ts` | `runtime-config.json`検証とAmplify設定 |
| `src/components/login-form.tsx` | Cognito・Entraログイン |
| `src/components/workspace.tsx` | 認証後レイアウト、設定、通知 |
| `src/components/conversation-sidebar.tsx` | チャット・プロジェクト・アーカイブUI |
| `src/components/chat-thread.tsx` | メッセージ、入力、添付、ツール、Reasoning |
| `src/components/runtime/ag-ui-runtime-provider.tsx` | AG-UI、認証fetch、履歴、各Adapter |
| `src/components/runtime/inference-settings.tsx` | モデルとReasoning選択 |
| `src/components/runtime/run-error-aware-http-agent.ts` | `RUN_ERROR`をassistant-uiの失敗通知へ接続 |
| `src/lib/debug.ts` | ブラウザデバッグの切り替え、マスク、Console出力 |
| `src/components/markdown-text.tsx` | Markdown表示 |
| `shared/model-catalog.ts` | モデル一覧と推論制約 |
