# セキュリティドキュメント — Strands AgentCore + assistant-ui Cost Control

このドキュメントは、本サンプルの脅威モデル、実装済みのセキュリティ統制、未実装の統制、責任分界、データ分類、リスク評価をまとめたものです。

> **このリポジトリは研究・学習用途のサンプルであり、プロダクションレディではありません。**
> 未実装の統制を「実装済み」と読み違えないよう、各節で実装の有無を明示しています。
> 運用上の既知の制約は[セキュリティ上の注意と既知の制約](doc/security-notes.md)にもまとめています。

## 脅威モデル（STRIDE）

### 構成要素

- **フロントエンド**: React / Vite のSPA。非公開S3バケットへ配置し、CloudFront（OAC）経由で配信
- **Amazon Cognito User Pool**: 利用者認証とJWT発行。オプションでMicrosoft Entra IDをOIDC Identity Providerとして連携
- **AgentCore Runtime**: Node.js 22のCodeZip。AG-UIプロトコルでSSEを返す。`customJwtAuthorizer`で保護
- **AgentCore Gateway**: Cognito JWTで保護したMCP Gateway。Runtimeから受け取った同一ユーザーのJWTを再検証
- **ツールLambda**: Gatewayからだけ呼び出す、固定の問い合わせ先を返す読み取り専用ツール
- **Amazon Bedrock**: Runtimeから呼び出す基盤モデルおよび推論プロファイル
- **AgentCore Memory**: 認証ユーザー単位の短期チャット履歴と、抽出された個人の事実・好みを保持
- **AWS KMS**: AgentCore Memoryをカスタマーマネージドキーで暗号化
- **Amazon S3（CodeZip用）**: Runtime成果物ZIPを置く非公開バケット
- **Amazon CloudWatch Logs**: Runtimeの`APPLICATION_LOGS`と`USAGE_LOGS`の配信先

BFF、Web Lambda、Lambda Function URL、RDSは**含みません**。LLM費用上限の強制にDynamoDB台帳を使用し、Gatewayターゲットとして呼び出すツールLambdaを含みます。
ブラウザがCognitoのJWTを持って、AgentCore Runtimeへ直接接続します。
S3デプロイ用のカスタムリソースLambdaはCloudFormation実行時にだけ動作します。ツールLambdaはRuntimeからGateway経由でツールを使った場合だけ動作します。

### STRIDE分析

| 脅威 | 対象 | リスク | 対策 | 実装 |
|---|---|---|---|---|
| **Spoofing** | AgentCore Runtime | 未認証でのBedrock呼び出し | `customJwtAuthorizer`によるCognito JWT検証。`allowedClients`をApp Client IDに限定 | 実装済み |
| **Spoofing** | Cognito | アカウントの自己登録による侵入 | `selfSignUpEnabled: false`。利用者は管理者が作成 | 実装済み |
| **Spoofing** | Cognito | 総当たり・ユーザー列挙 | SRP認証のみ許可（`userPassword`を無効）。`preventUserExistenceErrors: true`。12文字以上・4種混在のパスワードポリシー | 実装済み |
| **Spoofing** | ブラウザ | トークン奪取によるセッション乗っ取り | アクセストークン／IDトークンの有効期間を1時間に短縮 | 部分的（リフレッシュトークンは30日、`localStorage`保管） |
| **Tampering** | Runtime入力 | 不正なペイロード、巨大な入力 | `RunAgentInputSchema`（zod）による厳格な検証。不一致は400。`express.json`のサイズ上限4MB | 実装済み |
| **Tampering** | Runtime入力 | プロンプトインジェクション | 長期記憶を未信頼データとして扱うよう明示。Gatewayツールは固定データの読み取り専用 | 部分的（Guardrails未導入） |
| **Tampering** | ツール引数 | 不正な引数によるツールの誤動作 | Runtime内ツールはzod、GatewayツールはTool SchemaとLambdaで検証。未定義部署を拒否 | 実装済み |
| **Spoofing** | AgentCore Gateway | 未認証でのLambdaツール呼び出し | Runtimeと同じCognito User Pool / App ClientでJWTを再検証。GatewayからLambdaはIAMロールで実行 | 実装済み |
| **Tampering** | S3 | 配信物・CodeZipの改ざん | `BlockPublicAccess.BLOCK_ALL`、`enforceSSL: true`、CloudFrontはOACのみ許可 | 実装済み |
| **Repudiation** | Runtime | 実行履歴の追跡不能 | 1行1JSONの構造化ログをCloudWatch Logsへ配信（`event`、`threadId`で絞り込み可能） | 実装済み |
| **Repudiation** | CloudFront / S3 | アクセスの追跡不能 | — | **未実装**（アクセスログ未設定） |
| **Information Disclosure** | CloudWatch Logs | 利用者の入力とモデル応答の残存 | `runtimeLogRequest` / `runtimeLogModel` / `runtimeLogTool`で種別ごとに無効化可能。保持期間は既定3日 | 部分的（既定は本文を出力。ロググループのKMS暗号化とData Protection policyは未設定） |
| **Information Disclosure** | AgentCore Memory | 他ユーザーの履歴・個人記憶の参照 | JWT Authorizer検証済みトークンの`sub`をRuntimeで`actorId`に固定。MemoryはCMKで暗号化 | 実装済み |
| **Information Disclosure** | `runtime-config.json` | User Pool IDとApp Client IDの公開 | public App Clientの仕様上そもそも秘密情報ではない。SPAである以上隠蔽できない | 設計上の受容 |
| **Information Disclosure** | ブラウザ | XSS発生時のトークン露出 | — | **未実装**（CSP等のレスポンスヘッダー未設定。httpOnly Cookie化には本構成が排除したBFFが必要） |
| **Denial of Service** | AgentCore Runtime | 認証済み利用者による無制限のBedrock呼び出し | 費用hard limit、Cognitoグループ別ユーザートークン上限、DynamoDBの原子的予約 | 実装済み（時間当たりのリクエストレート制限は未実装） |
| **Elevation of Privilege** | IAMロール | 過剰な権限 | Runtimeロールをモデル・ログ・成果物・Memoryに、Gatewayロールを対象ツールLambdaの実行に限定 | 実装済み |

### 攻撃面

- **外部**: CloudFrontの配信URL、Cognito Hosted UI、AgentCore RuntimeのInvokeエンドポイント、AgentCore GatewayのMCPエンドポイント
- **内部**: Runtime → Bedrock、Runtime → Gateway → ツールLambda、Runtime → AgentCore Memory、Runtime → CloudWatch Logs、Runtime起動時のCodeZip取得（S3）
- **データフロー**: 利用者入力 → ブラウザ（AG-UI + Bearer JWT） → AgentCore Runtime → Bedrock / Gateway / AgentCore Memory → SSEまたは履歴JSONでブラウザへ返却

## 実装済みのセキュリティ統制

以下はCDKスタックのデプロイで自動的に構成されます。手動設定は不要です。

### 認証と認可

- Amazon Cognito User Poolで認証する。パスワードは12文字以上、大文字・小文字・数字・記号をすべて必須とする
- 仮パスワードの有効期間は7日
- 自己登録は無効（`selfSignUpEnabled: false`）。アカウント復旧はメールのみ
- Cognitoログインを表示する構成でも認証フローはSRPのみを許可する。UIを迂回した`InitiateAuth`での`USER_PASSWORD_AUTH`は成立しない
- Cognitoログインを表示しない構成では`ExplicitAuthFlows`を`ALLOW_REFRESH_TOKEN_AUTH`だけに明示する。CDKの既定に戻ってSRPが復活することを防ぐ
- 画面に出さない認証手段は`supportedIdentityProviders`からも外し、Hosted UI経由でも選べないようにする
- AgentCore Runtimeは`customJwtAuthorizer`で保護し、`discoveryUrl`にUser Poolのdiscovery URL、`allowedClients`にApp Client IDを指定する。条件を満たさないリクエストはAWS側で拒否される
- AgentCore Gatewayも同じUser PoolとApp ClientでJWTを検証する。Runtimeは検証済みBearer tokenをMCPリクエストへ設定し、ユーザー認証境界を維持する
- OAuthはAuthorization Code Grantのみ。スコープは`openid email profile`

### 暗号化と通信

- CloudFrontの`viewerProtocolPolicy`は`REDIRECT_TO_HTTPS`
- Web用・CodeZip用の両S3バケットで`BlockPublicAccess.BLOCK_ALL`と`enforceSSL: true`を設定する
- S3の保管時暗号化はS3管理キー（SSE-S3）
- CloudFrontはOrigin Access Control（OAC）でのみS3を参照する。バケットへの直接アクセスは成立しない
- AWSサービス間の通信はTLS（各サービスのエンドポイントが強制）

### 入力検証

- `POST /invocations`は`RunAgentInputSchema`で検証し、不一致は400と検証エラー内容を返す
- リクエストボディの上限は4MB
- ツールの引数はzodスキーマで検証する。加えて次を実行時に拒否する
  - 計算ツール: 非有限数の被演算子、ゼロ除算、非有限の結果
  - 日時ツール: 無効なIANAタイムゾーン
  - 文字数統計ツール: 100,000 UTF-16コードユニットを超えるテキスト
  - Knowledge Base検索ツール: 空の検索語、1,000文字超の検索語、1～10以外の取得件数
  - Gateway問い合わせ先ツール: `sales`、`support`、`billing`以外の部署
- ツールは計算、現在日時、文字数統計、ユーザー確認、固定の問い合わせ先検索、指定済みKnowledge Base検索のみ。ファイル、Web、任意AWS API、OSコマンドへの到達手段を持たない

### IAM最小権限

Runtime実行ロールとGateway実行ロールの権限を用途別に分離します。

| 権限 | リソース | 備考 |
|---|---|---|
| `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` | モデルカタログに定義したinference profileとfoundation modelのARN | US Geo Inference Profileを使うモデルは`us-east-1` / `us-east-2` / `us-west-2`のfoundation model ARNも許可する。クロスリージョン推論の実行先がこの3リージョンに及ぶため |
| `bedrock:Retrieve` | デプロイ時に指定したKnowledge Base ARN | Runtimeから既存Knowledge Baseを検索するため。ワイルドカードは使用しない |
| `logs:CreateLogGroup`, `logs:DescribeLogGroups` | `log-group:*` | AgentCoreがロググループ名を決めるため事前にARNを固定できない。**このワイルドカードはAWS側の設計制約による** |
| `logs:DescribeLogStreams`, `logs:CreateLogStream`, `logs:PutLogEvents` | `/aws/bedrock-agentcore/runtimes/*` | AgentCore Runtimeのロググループ配下に限定 |
| S3読み取り（`grantRead`） | CodeZip用バケット | Runtime起動時の成果物取得のみ |
| `lambda:InvokeFunction` | 問い合わせ先検索Lambda | Gateway実行ロールにだけ付与 |

`service:*`形式のワイルドカードは使用していません。

### 監査とログ

- Runtimeのログは保持期間を明示したCloudWatch Logsロググループへ配信する。既定は3日で、`-c logRetentionDays=<日数>`で変更できる
- 配信対象は`APPLICATION_LOGS`と`USAGE_LOGS`
- ログは1行1JSONの構造化形式で、`event`と`threadId`で絞り込める
- 種別ごとの出力はデプロイ時に無効化できる

| 種別 | 出力内容 | 無効化 |
|---|---|---|
| `request` | 受信したAG-UI入力。**利用者のメッセージ本文を含む** | `-c runtimeLogRequest=off` |
| `model` | 応答本文、思考の文字数、所要時間。**モデルの応答本文を含む** | `-c runtimeLogModel=off` |
| `tool` | ツール名、引数、実行結果 | `-c runtimeLogTool=off` |
| エラー | 失敗時のメッセージとスタック | 無効化できない |

> **既定では利用者の入力とモデルの応答がそのままCloudWatch Logsへ残ります。**
> 個人情報や秘密情報を扱う場合は`runtimeLogRequest`と`runtimeLogModel`を`off`にしてください。

- AWS APIの呼び出しはAWS CloudTrailに記録される（アカウント既定の証跡）

## 未実装のセキュリティ統制

本サンプルには次の統制が**ありません**。業務利用の前に実装が必要です。

| 項目 | 未実装の内容 | 想定される影響 |
|---|---|---|
| セキュリティレスポンスヘッダー | CSP、X-Frame-Options、HSTS、X-Content-Type-Optionsが未設定 | ログイン済み利用者に対するクリックジャッキングが成立する。XSS発生時の多層防御がない |
| WAF・レート制限 | AWS WAFと時間当たりのリクエスト回数制限は未配置。費用・ユーザートークン上限は実装済み | 上限内での短時間連投により可用性へ影響する可能性がある |
| Bedrock Guardrails | 入出力のコンテンツフィルタ、プロンプト攻撃検出、PIIマスキング、禁止トピックが未設定 | ジェイルブレイクや不適切な入出力を機械的に遮断できない |
| 出力フィルタリング | 応答内の資格情報パターン除去や長さ制限がない | モデル応答がそのまま利用者へ返る |
| リフレッシュトークン | 有効期間が30日と長い | 端末が侵害された場合の再利用可能期間が長い |
| トークン保管 | JWTはAmplifyの既定で`localStorage`に保存される | XSS発生時にトークンが露出する。httpOnly Cookie化には本構成が排除したBFFが必要 |
| リダイレクトURL | 本番App Clientのcallback / logout URLに`http://localhost:5173/`が含まれる | 開発用リダイレクト先が本番クライアントに残る |
| アクセスログ | CloudFrontとS3のアクセスログが未設定 | インシデント発生時にこの経路を追跡できない |
| ログの暗号化 | ロググループのKMS暗号化とData Protection policyが未設定 | 利用者の入力がCloudWatch Logsに平文で残る |
| エラー表示 | ログイン失敗時にCognitoの原文メッセージをそのまま表示する | 内部エラー文言が利用者に見える |
| トレース | X-RayトレースとCloudWatch GenAI Observabilityのスパンを含めない | アカウント・リージョン単位でTransaction Searchを有効にする必要があり、本スタックの範囲外とした |
| ネットワーク | Runtimeの`networkMode`は`PUBLIC` | 本番ではVPC構成の検討が必要 |
| マルチリージョン | `us-east-1`の単一リージョン | 可用性とデータ所在の要件を満たさない場合がある |

## サービス別のセキュリティ指針

### Amazon Cognito

- パスワードポリシー: 12文字以上、大文字・小文字・数字・記号を必須
- 仮パスワードの有効期間は7日、アカウント復旧はメールのみ
- 自己登録は無効。利用者の追加は`scripts/manage-cognito-user.mjs`から管理者が行う
- `preventUserExistenceErrors: true`でユーザー列挙を防ぐ
- 昇格の余地: Advanced Security（ENFORCED）、MFA必須化、リフレッシュトークン期間の短縮
- 監視: CloudTrailの認証イベント、CloudWatchでのログイン失敗パターン

### Microsoft Entra ID（オプション）

- OIDC Identity Providerとして構成する。`authorize_scopes`は`openid email`、属性マッピングは`email` / `sub`のみ
- クライアントシークレットはリポジトリに置かない。CDKはSecrets Managerの動的参照として解決する（`entraClientSecretName`でシークレット名だけを渡す）
- Entra経由のログインでは`fetchUserAttributes`（Cognitoの`GetUser` API）を使えない。アクセストークンに`aws.cognito.signin.user.admin`スコープが必要だが、Hosted UIのAuthorization Code FlowではApp Clientに許可したスコープしか付与されないため。表示名はIDトークンのクレームから組み立てる（`src/lib/current-user.ts`）
- 疎通確認は管理者アカウント1件のみ。複数ユーザーやグループ割り当て下での動作は未確認

> **`-c entraEnabled=true`を付けずにデプロイすると、設定済みのEntra Identity Providerが削除されます。**
> CDKコンテキストは前回値を保存しません。Entra構成では[デプロイ手順書](doc/deployment-guide.md)のコンテキストをすべて渡してください。

### Amazon Bedrock AgentCore

- `customJwtAuthorizer`でCognito JWTを検証し、許可リストで`Authorization`ヘッダーだけをRuntimeへ転送する。Runtimeは検証済みJWTの`sub`をMemoryの`actorId`として使う
- Gatewayも同じCognito JWTを検証し、MCP `tools/list` / `tools/call`を提供する。Gatewayの実行ロールは対象Lambdaだけを呼び出せる
- Runtime実行ロールはモデルARN、ログ、成果物バケットと対象Memoryに限定する
- `networkMode`は`PUBLIC`。本番ではPRIVATEを検討する
- セッションは`idleRuntimeSessionTimeout` 300秒、`maxLifetime` 1800秒
- 短期記憶は30日間保持する。長期記憶は`/workmate/{actorId}/facts`と`/workmate/{actorId}/preferences`へユーザー単位で抽出する
- Memoryはキーローテーションを有効にしたカスタマーマネージドKMSキーで暗号化する

### Amazon S3 / Amazon CloudFront

- Web用・CodeZip用の両バケットで`BlockPublicAccess.BLOCK_ALL`、`enforceSSL: true`、SSE-S3
- CloudFrontはOACでのみオリジンを参照する
- `runtime-config.json`だけはキャッシュ無効の別ビヘイビアにする。設定変更が即時に反映されるようにするため
- 403 / 404はSPAの`index.html`へフォールバックする
- **アクセスログは未設定**。本番では有効化する

### AWS IAM

- すべてのロールで具体的なアクションを列挙する（`service:*`は使わない）
- ワイルドカードのリソースは`logs:CreateLogGroup` / `logs:DescribeLogGroups`のみで、AWS側の設計制約による
- CDKのBucketDeploymentが作るカスタムリソースLambdaのロールはCloudFormation実行時にだけ使われる。アプリの通信経路には存在しない
- 推奨: IAM Access Analyzerによる四半期ごとの棚卸し

```bash
aws accessanalyzer list-analyzers --region us-east-1
```

## 責任分界（Shared Responsibility Model）

| AWSサービス | AWSの責任 | 利用者の責任 |
|---|---|---|
| **Amazon Cognito** | ID基盤、SRPプロトコルの実装 | パスワードポリシー、MFA、Advanced Security、ユーザー管理、トークン有効期間 |
| **Amazon Bedrock AgentCore** | Runtime基盤、コンピュートの分離、JWT検証機構 | 実行ロール、ネットワークモード、モデル選択、入力検証、プロンプト設計 |
| **AgentCore Gateway** | MCP集約、JWT検証、Lambdaターゲット呼び出し基盤 | Tool Schema、対象権限、ツールの副作用、入力・出力検証 |
| **AWS Lambda** | 関数実行基盤、実行環境の分離 | ハンドラー実装、入力検証、タイムアウト、ログ、実行ロール |
| **AgentCore Memory** | 記憶の保管、短期イベントAPI、長期記憶の抽出・検索基盤 | 保持期間、名前空間、actor/session ID設計、アクセス権、削除方針 |
| **Amazon Bedrock** | モデルのホスティングと推論 | モデル選択、Guardrails、入出力の取り扱い、コスト管理 |
| **Amazon S3** | ストレージ基盤、既定の暗号化 | パブリックアクセス設定、バケットポリシー、暗号化方式、ライフサイクル |
| **Amazon CloudFront** | 配信基盤、DDoSの基礎防御 | WAF、レスポンスヘッダー、アクセスログ、TLS設定、キャッシュ設計 |
| **Amazon CloudWatch Logs** | ログ保管基盤 | 保持期間、暗号化、Data Protection policy、アクセス制御 |
| **AWS Secrets Manager** | 保管と暗号化 | シークレットの登録、ローテーション、アクセスポリシー |
| **Microsoft Entra ID** | IdP基盤（Microsoftの責任） | アプリ登録、管理者同意、ユーザー割り当て、クライアントシークレットの管理 |

## データ分類

| 区分 | データ | 保護 |
|---|---|---|
| **HIGH** | Cognitoの認証情報、アクセス／ID／リフレッシュトークン、Entraのクライアントシークレット | Cognito側で管理。Entraのシークレットはリポジトリに置かずSecrets Managerで保持。トークンはブラウザの`localStorage`（**XSS耐性なし**） |
| **MEDIUM** | 利用者の入力、モデルの応答、抽出された個人の事実・好み、ツールの引数と結果、`threadId` | チャットと個人記憶はAgentCore MemoryでCMK暗号化。短期履歴は30日間保持。ログにも既定3日出力され、種別ごとに無効化可能。ログのKMS暗号化は未設定 |
| **LOW** | User Pool ID、App Client ID、Cognitoドメイン、Runtime ARN、静的アセット | `runtime-config.json`として公開。public App Clientの仕様上、秘密情報ではない |

## リスク評価

### セキュリティリスク

| リスク | 深刻度 | 対策 | 残存リスク |
|---|---|---|---|
| 未認証のBedrock呼び出し | HIGH | `customJwtAuthorizer`、`allowedClients`限定、自己登録無効 | LOW |
| 認証済み利用者による課金の増大 | HIGH | アカウント・プロジェクト費用hard limit、ユーザー単位トークン上限、原子的な事前予約 | LOW（LLM以外のAWSサービス費用は対象外） |
| プロンプトインジェクション | HIGH | 入力スキーマ検証、読み取り専用Gatewayツール、制約付きシステムプロンプト | MEDIUM（Guardrails未導入。ただしGatewayツールは固定データの参照だけで被害範囲は限定的） |
| XSS経由のトークン露出 | HIGH | React既定のエスケープのみ | **MEDIUM**（CSP未設定、`localStorage`保管） |
| クリックジャッキング | MEDIUM | — | **MEDIUM**（X-Frame-Options / CSP frame-ancestorsが未設定） |
| ログ経由の情報漏えい | MEDIUM | 保持期間3日、種別ごとの無効化 | MEDIUM（既定で本文を出力、KMS暗号化なし） |
| インシデント時の追跡不能 | MEDIUM | Runtimeの構造化ログ、CloudTrail | MEDIUM（CloudFront / S3のアクセスログが未設定） |
| 認証情報の漏えい | HIGH | ハードコードされたシークレットなし。EntraのシークレットはSecrets Manager参照 | LOW |

### 運用リスク

- **可用性**: `us-east-1`の単一リージョン構成。マルチリージョンは未検討
- **永続性**: 完了したチャットターンはAgentCore Memoryへ保存し再読み込み後に復元する。プロジェクト、チャット名変更、アーカイブ、フィードバックは永続化しない
- **コスト**: Bedrockの対応LLMモデル費用にはDynamoDB台帳による月額hard limitと、日次・週次・月次のユーザートークン上限を適用する。AgentCore Runtime、Memory、KMS、CloudFront、CloudWatch Logs等は対象外のためAWS Budgetsでの監視を併用する
- **モデル可用性**: `Claude Sonnet 5`はアカウントによって実行が拒否される場合がある。詳細は[README](README.md#制約)を参照

### コンプライアンス上の考慮

- **データプライバシー**: 利用者の入力とモデルの応答はAgentCore Memoryへ保存され、既定でCloudWatch Logsにも残る。個人情報を扱う場合は保持・削除要件を確認し、`runtimeLogRequest`と`runtimeLogModel`を`off`にする
- **データ所在**: `us-east-1`にデプロイする。US Geo Inference Profileを使うモデルでは推論が`us-east-1` / `us-east-2` / `us-west-2`に及ぶ。データレジデンシー要件がある場合は要検討
- **AIの取り扱い**: Amazon Bedrockの基盤モデルのみを使用し、カスタム学習データは持たない

## 検証範囲

- Microsoft Entra ID連携は、利用するテナントで管理者同意、一般ユーザー、グループ割り当て、ログアウト、トークン更新を含むE2E検証が必要
- 自動テストは設定・ユーティリティ層とRuntimeの単体・結合テストのみ。UIコンポーネントテストとE2Eテストはない
- 脆弱性診断、ペネトレーションテスト、負荷試験は実施していない

## 脆弱性の報告

本リポジトリのサンプルコードに関する問題は、リポジトリのIssueで報告してください。
AWSサービス自体の脆弱性を発見した場合は、Issueではなく[AWS Vulnerability Reporting](https://aws.amazon.com/security/vulnerability-reporting/)へ報告してください。
