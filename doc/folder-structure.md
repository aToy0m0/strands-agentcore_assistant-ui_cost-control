# フォルダ構成

この資料は、`14_assistant-ui-ag-ui-cost-control`のソースコード、インフラ、テスト、生成物の配置意図を説明する。

## 全体構成

<pre>
14_assistant-ui-ag-ui-cost-control/
├─ <strong><u>src/                              ブラウザで動くReactフロントエンドのソースコード</u></strong>
│  ├─ components/                   画面固有のReactコンポーネント
│  │  ├─ <em>runtime/                  assistant-uiとAgentCore Runtimeの通信・状態管理を接続するコード</em>
│  │  └─ <em>ui/                       ボタンやダイアログなど、画面全体で再利用するUI部品</em>
│  └─ lib/                          ユーザー情報、推論設定、デバッグなどのブラウザ内ロジック
├─ <strong><u>runtime/                          AgentCoreへCodeZipとしてデプロイするサーバー側の実行コード</u></strong>
│  ├─ src/                          AG-UI受付、認証、Bedrock推論、Memory、ツール連携の実装
│  ├─ integration/                  HTTPリクエストを含むRuntimeの結合テスト
│  ├─ scripts/                      Runtimeのビルド、ZIP作成、単体デプロイを行うスクリプト
│  └─ dist/                         Runtimeのビルドで生成されるJavaScript
├─ <strong><u>gateway-tool/                     AgentCore Gateway経由で実行する問い合わせ先検索Lambda</u></strong>
├─ <strong><u>infrastructure/                   CloudFront、Cognito、AgentCoreなどを作成するAWS CDK定義</u></strong>
├─ <strong><u>shared/                           ログイン方式、モデル、ユーザー上限プロファイルの共通定義</u></strong>
├─ <strong><u>scripts/                          デプロイ、Cognitoユーザー、上限プロファイル、Entra IDの運用スクリプト</u></strong>
│  └─ entra/                        Entra IDアプリの登録、権限付与、シークレット更新を行うPowerShellスクリプト
├─ <strong><u>test/                             UIロジック、共有定義、CDKテンプレートの回帰テスト</u></strong>
├─ <strong><u>public/                           Viteがそのまま配信物へコピーするローカル開発用設定</u></strong>
├─ <strong><u>doc/                              デプロイ、機能、セキュリティ、フォルダ構成の説明資料</u></strong>
│  └─ images/                       Markdown文書から参照する構成図
├─ <strong><u>dist/                             フロントエンドのビルドで生成される静的配信物</u></strong>
├─ <strong><u>cdk.out*/                         CDK synthで生成されるCloudFormationテンプレートとアセット</u></strong>
├─ <strong><u>package.json                      ルートで実行するビルド、テスト、デプロイコマンドの定義</u></strong>
├─ <strong><u>cdk.json                          CDKアプリの起動コマンドとコンテキスト設定</u></strong>
├─ <strong><u>vite.config.ts                    Reactフロントエンドのビルド設定</u></strong>
├─ <strong><u>vitest.config.ts                  ルート側単体テストの実行設定</u></strong>
├─ <strong><u>tsconfig*.json                    ブラウザ、Node.js、プロジェクト全体のTypeScript設定</u></strong>
├─ <strong><u>README.md                         システム概要と利用開始時の入口</u></strong>
└─ <strong><u>SECURITY.md                       脅威モデル、実装済み統制、既知のリスク</u></strong>
</pre>

`dist/`、`cdk.out*/`、`runtime/dist/`、`runtime/deployment_package.zip`、各`node_modules/`はコマンドから再生成するため、ソースとして管理しない。

## ディレクトリの責務

| パス | 責務 | 主な内容 |
|---|---|---|
| `src/` | ブラウザで動くUI | Cognitoログイン、会話一覧、チャット表示、AG-UI通信 |
| `src/components/runtime/` | UIとRuntimeの接続境界 | JWTを付けたRuntime呼び出し、推論設定、タブ内のスレッド表示状態 |
| `runtime/src/` | AgentCore Runtimeのアプリケーション | AG-UI SSE、Bedrock推論、厳密なトークン計数、費用・ユーザー上限台帳、チャット履歴、長期記憶、Gatewayツール |
| `runtime/integration/` | Runtimeの外部境界を含む検証 | invocations入力やバリデーションの結合テスト |
| `gateway-tool/` | AgentCore GatewayのLambdaターゲット | 問い合わせ先検索ツールとNode.js標準テスト |
| `infrastructure/` | AWSリソースの唯一の定義 | CloudFront、S3、Cognito、Runtime、Memory、Gateway、Lambda、IAM、ログ |
| `shared/` | 複数レイヤーで一致させる定義 | ログイン方式、モデルカタログ、ユーザー上限プロファイルの検証 |
| `scripts/` | デプロイと構築後の管理作業 | 設定ファイル経由のCDKデプロイ、Cognitoユーザー・上限プロファイル管理、Entra操作 |
| `test/` | ルート側の回帰テスト | UIロジック、設定、CDKテンプレートの検証 |
| `public/` | 開発時の静的ファイル | ローカル用`runtime-config.json` |
| `doc/` | 利用者・開発者向け資料 | デプロイ、セキュリティ、フォルダ構成、構成図 |

## 下位階層まで見れば変更箇所を特定できる

### `src/`は画面、Runtime接続、ブラウザ内ロジックに分かれる

| パス | 責務 | 代表ファイル |
|---|---|---|
| `src/components/` | アプリ固有の画面を組み立てる | `workspace.tsx`、`chat-thread.tsx`、`conversation-sidebar.tsx`、`login-form.tsx` |
| `src/components/runtime/` | assistant-uiの状態とAG-UI通信を接続する | `ag-ui-runtime-provider.tsx`、`inference-settings.tsx`、`run-error-aware-http-agent.ts` |
| `src/components/ui/` | アプリ全体で再利用する表示部品を提供する | `button.tsx`、`dialog.tsx`、`select.tsx`、`tooltip.tsx` |
| `src/lib/` | React画面から独立したブラウザ内ロジックを置く | `current-user.ts`、`runtime-options.ts`、`debug.ts`、`remark-html-line-break.ts` |
| `src/config.ts` | `runtime-config.json`を読み、CognitoとRuntime接続を初期化する | 設定値の検証、Amplify設定、Runtime URL生成 |
| `src/main.tsx`、`src/app.tsx` | Reactを起動し、認証状態に応じて画面を切り替える | アプリケーションのエントリーポイント |

### `runtime/`は実行コード、同居テスト、外部境界テスト、成果物作成に分かれる

| パス | 責務 | 代表ファイル |
|---|---|---|
| `runtime/src/` | AgentCore Runtimeで動くアプリケーション本体 | `main.ts`、`app.ts`、`model-factory.ts`、`token-counter.ts`、`budget-ledger.ts`、`memory.ts`、`tools.ts` |
| `runtime/src/*.test.ts` | 各Runtimeモジュールを同じ階層で単体検証する | 認証、CountTokens、費用・ユーザー上限、履歴、Memory、ログ、モデル、イベント変換のテスト |
| `runtime/integration/` | HTTPの`/invocations`境界と実行入力を結合検証する | `invocations.test.ts`、`validation.test.ts`、`server-only.ts` |
| `runtime/scripts/` | Runtimeをビルドし、CodeZip用ZIPを作成・配置する | `build.mjs`、`package.mjs`、`deploy.ts` |
| `runtime/package.json` | Runtimeだけの依存関係とNode.js 22向けコマンドを固定する | build、package、test、deploy、dev |
| `runtime/.env.example` | ローカル実行に必要な環境変数名を示す | AWSリージョン、Memory、Gatewayなどの設定入口 |

### AWS境界と共通定義は役割ごとに独立している

| パス | 責務 | 代表ファイル |
|---|---|---|
| `gateway-tool/` | GatewayのLambdaターゲットとそのテストを置く | `index.mjs`、`index.node-test.mjs` |
| `infrastructure/` | CDKアプリを起動し、全AWSリソースを定義する | `app.ts`、`stack.ts` |
| `shared/` | UI、Runtime、CDKで同じ値を使う定義を一元化する | `login-methods.ts`、`model-catalog.ts`、`user-limit-profiles.ts` |
| `scripts/` | デプロイ設定を渡し、Cognitoユーザーと上限プロファイルを管理する | `Deploy-Workmate.ps1`、`deploy-config.example.psd1`、`manage-cognito-user.mjs` |
| `scripts/entra/` | Microsoft Graph経由でEntra OIDCアプリを管理する | `New-EntraCognitoOidcApplication.ps1`、`Update-EntraCognitoOidcRedirectUri.ps1`など |
| `test/` | UIロジック、共有定義、CDKテンプレートを回帰検証する | `config.test.ts`、`login-methods.test.ts`、`infrastructure.test.ts` |
| `public/` | ローカル開発時にViteがそのまま配信する静的設定を置く | `runtime-config.json` |

## フロントエンド

`src/main.tsx`が起点となり、`src/app.tsx`から認証済みワークスペースまたはログイン画面を表示する。

- `components/login-form.tsx`: CognitoとMicrosoft Entra IDのログイン入口
- `components/workspace.tsx`: 認証後画面の組み立て
- `components/conversation-sidebar.tsx`: 新規チャット、一覧、アーカイブ表示
- `components/chat-thread.tsx`: メッセージと入力欄
- `components/runtime/ag-ui-runtime-provider.tsx`: assistant-uiをAgentCore Runtimeへ接続
- `components/ui/`: Radix系の再利用可能な表示部品
- `lib/agents.ts`: 画面に表示するエージェント情報
- `lib/runtime-options.ts`: モデルや推論オプションの状態

チャット本文の永続化はブラウザ側では行わない。RuntimeがAgentCore Memoryへ保存・復元する。チャット名、ピン留め、アーカイブなどの一覧表示状態は、このサンプルではブラウザタブ内だけに保持する。

## AgentCore Runtime

`runtime/src/main.ts`がCodeZipの起動点、`runtime/src/app.ts`が`POST /invocations`を処理するアプリケーション本体となる。

- `auth.ts`: AgentCoreから渡されるJWTクレームの検証とユーザー識別
- `history.ts`: 短期記憶からチャット履歴を復元
- `memory.ts`: 短期記憶へのターン保存と長期記憶の検索
- `model-factory.ts`: 選択されたBedrockモデルの生成
- `tools.ts`: AgentCore GatewayへのMCP接続
- `stream-events.ts`: StrandsのイベントをAG-UIイベントへ変換
- `logging.ts`: Runtimeの構造化ログ
- `system-prompt.ts`: エージェントの基本指示

Runtimeの依存関係とビルドはルートから分離している。`npm run runtime:build`は`runtime/`内で依存関係を固定してビルドし、`runtime/deployment_package.zip`を生成する。

## インフラとデプロイ

`infrastructure/app.ts`がCDKアプリの起点で、AWSリソースは`infrastructure/stack.ts`の`WorkmateCostControlStack`へ集約している。

```text
src/ ── npm run build ──> dist/
                            │
runtime/src/ ── package ──> runtime/deployment_package.zip
                            │
                            v
infrastructure/stack.ts ── CDK deploy
  ├─ dist/をWeb用S3へ配置しCloudFrontから配信
  ├─ runtime-config.jsonを実AWSリソースの値で生成
  ├─ Runtime ZIPを専用S3へ配置してAgentCore Runtimeを更新
  ├─ DynamoDB費用・ユーザー上限台帳とCognito上限グループを作成
  ├─ オプション有効時だけCloudFront独自ドメインとRoute 53 Alias Aを設定
  └─ Gateway Lambdaをgateway-tool/からパッケージ
```

`public/runtime-config.json`はローカル開発用となる。本番ではCDKがUser Pool ID、App Client ID、Cognitoドメイン、Runtime ARNを含む`runtime-config.json`を生成し、`dist/`と一緒にWeb用S3へ配置する。

## テストの配置

| 対象 | 配置 | 実行コマンド |
|---|---|---|
| UI・共有ロジック・CDK | `test/` | `npm run test:unit` |
| Runtime | `runtime/src/*.test.ts` | `npm run runtime:test` |
| Runtime結合テスト | `runtime/integration/` | Runtime側の専用テスト設定を使用 |
| Gateway Lambda | `gateway-tool/index.node-test.mjs` | `npm run gateway:test` |
| 全体 | 上記すべてとbuild・lint・synth | `npm run verify` |

実装とテストは同じ責務単位で対応させる。IAMやAWSリソースを変更した場合は、`test/infrastructure.test.ts`で生成されるCloudFormationテンプレートも検証する。

## 変更目的ごとの編集先

| 変更したい内容 | 主な編集先 |
|---|---|
| 画面、チャットUI、ログイン表示 | `src/components/`、`src/index.css` |
| モデル選択肢 | `shared/model-catalog.ts` |
| CountTokens経路と費用予約 | `runtime/src/token-counter.ts`、`runtime/src/model-factory.ts`、`runtime/src/budget-ledger.ts` |
| ユーザー上限プロファイル | `shared/user-limit-profiles.ts`、`runtime/src/auth.ts`、`runtime/src/budget-ledger.ts`、`scripts/manage-cognito-user.mjs` |
| カスタムドメイン | `infrastructure/stack.ts`、`scripts/deploy-config.example.psd1` |
| ログイン方式 | `shared/login-methods.ts`、`src/config.ts`、`infrastructure/stack.ts` |
| チャット履歴・長期記憶 | `runtime/src/history.ts`、`runtime/src/memory.ts` |
| プロンプトやモデル実行 | `runtime/src/system-prompt.ts`、`runtime/src/model-factory.ts` |
| Gateway経由のツール利用 | `runtime/src/tools.ts`、`gateway-tool/`、`infrastructure/stack.ts` |
| AWSリソース、IAM、ログ保持 | `infrastructure/stack.ts` |
| CognitoユーザーやEntra設定の運用 | `scripts/` |
| デプロイ方法 | `doc/deployment-guide.md` |
| Runtimeの実装機能 | `doc/runtime-features.md` |
| UIの実装機能 | `doc/ui-features.md` |
| セキュリティ制約 | `SECURITY.md`、`doc/security-notes.md` |

## 配置ルール

- ブラウザだけで必要なコードは`src/`へ置く。
- AgentCore Runtimeでだけ必要なコードは`runtime/`へ置く。
- 複数レイヤーで一致が必要な値だけを`shared/`へ置く。
- Gatewayターゲットの処理は`gateway-tool/`へ置き、Runtimeへ埋め込まない。
- AWSリソースやIAMの変更は`infrastructure/stack.ts`へ集約する。
- ビルド生成物を直接修正しない。必ず生成元を変更して再ビルドする。
- 認証情報、アクセストークン、クライアントシークレットをリポジトリへ保存しない。
