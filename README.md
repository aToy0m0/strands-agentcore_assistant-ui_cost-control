# Assistant UI + AgentCore cost control

Amazon BedrockとGoogle Geminiを同じチャットUIから利用し、アプリ単位のソフト月額上限でモデル費用を制御するサンプルです。配置先は`us-east-1`と`ap-northeast-1`をJSON configで切り替えられます。

## 主な機能

- Amazon Cognito認証と任意のMicrosoft Entra ID OIDC連携
- AgentCore Runtimeとブラウザ間のAG-UIストリーミング
- AgentCore Memoryによる会話履歴と利用者単位の長期記憶
- 複数のAgentCore Runtimeをヘッダーから切り替えるUI
- 回答と同じMarkdownレンダーを使った送信前プレビュー
- 複数のBedrock Knowledge Base検索ツール。Gateway Lambda経由を優先し、Runtime直接検索も予備として保持
- AgentCore Gateway経由の複数Lambdaターゲットとmetadata JSONによるKnowledge Base絞り込み
- Amazon BedrockとGoogle Geminiを共通UIから選択するモデルカタログ
- 任意で作成できるCloudWatch Dashboardによるモデル費用とトークン数の可視化

## 費用制御

各モデル呼び出しの前に、プロバイダー標準のCountTokensを優先して入力トークン数を取得します。標準APIを利用できない場合はStrands SDKの推定値を使い、切り替えを構造化ログへ記録します。自作トークナイザーと最大出力費用の予約は使用しません。

```text
入力トークン数を取得
  -> S3のVersioning付き価格表を読む
  -> 当月実績 + 入力見積りが月額上限内か確認
  -> モデルを呼び出す
  -> 応答usageと使用時単価を冪等に記録
```

応答usageを取得できない場合は架空費用を計上しません。推論開始前の拒否は`NO_CHARGE`、ストリーム開始後の欠落は`USAGE_UNAVAILABLE`として金額なしで記録し、他の呼び出しは止めません。`usageEventId`により再試行時の二重記録を防ぎます。

価格表はS3オブジェクトのVersion IDを含めて費用ログへ残します。AWS公式Price Listとの日次照合は警告専用で、価格不一致によって呼び出しを停止したり価格表を書き換えたりしません。GeminiはAWS照合対象外のため、価格表の確認期限を警告します。

## デプロイ

Node.js 24、AWS CLI、CDKを準備し、AWS CLIプロファイル`cdkdep`を設定します。CDKのdiffとdeployは`scripts/deploy.mjs`を経由し、別プロファイルは受け付けません。

```powershell
Copy-Item .\scripts\deploy-config.us-east-1.example.json .\scripts\deploy-config.json
npm ci
npm run runtime:install
npm run deploy:diff
npm run deploy
```

東京配置では`deploy-config.ap-northeast-1.example.json`をコピーします。`scripts/deploy-config.json`はGit管理外です。CloudFrontの独自ドメインを使う場合、配置リージョンにかかわらずACM証明書は`us-east-1`で発行します。

Cognitoの自己サインアップは無効です。初回利用者は[デプロイ手順](doc/deployment-guide.md#cognito利用者を作成する)に従い、管理スクリプトから作成します。

主要設定は次のとおりです。

- `defaultCdkPrefix`: AWSリソース名、費用集計ID、Memory名前空間の共通入力
- `monthlyBudgetUsd`: アプリ全体のソフト月額上限。再デプロイ後の次回判定から有効
- `enabledModelKeys`: UI、Runtime検証、Bedrock IAMへ共通適用するモデルallowlist
- `modelIds`: モデルキーごとの実呼び出しID。US／東京サンプルにリージョン別の推奨IDを収録
- `knowledgeBases`: 利用可能な複数Knowledge Base
- `gatewayTargets`: コード側カタログから有効化する複数Lambdaターゲット
- `additionalRuntimes`: UIのアプリ選択へ追加する複数の既存AgentCore Runtime。Runtime IDまたはARNを指定
- `logRetentionDays`: CloudWatch Logs保持日数。開発は短期、本番は180日など環境別に指定
- `priceVerificationEnabled`: 軽量な価格照合Lambda、メトリクス、Alarmの有効化
- `costDashboardEnabled`: 費用Dashboardと専用Metric Filterの有効化。現行サンプルは`false`

全項目は[デプロイ設定一覧](doc/deployment-context-options.md)、運用は[デプロイ手順](doc/deployment-guide.md)を参照してください。

Bedrock上でモデルが一覧表示され、契約状態が`AVAILABLE`でも、AWSアカウント単位の提供制限によりGPT-5.6 Luna、GPT-5.6 Sol、Claude Sonnet 5などが推論時に拒否される場合があります。これはモデルIDの誤りとは限りません。確認方法と切り分けは[Bedrockモデル利用契約の事前準備](doc/model-access-prerequisites.md)を参照してください。

## 検証

```powershell
npm run verify
npm run deploy:test
```

## 構成

- `infrastructure/stack.ts`: Cognito、CloudFront、AgentCore、DynamoDB、S3価格表、CloudWatch
- `runtime/src/model-factory.ts`: プロバイダー選択、事前判定、usage記録
- `runtime/src/budget-ledger.ts`: 月次実績、冪等性、金額を持たない失敗記録
- `runtime/src/pricing-catalog.ts`: Versioning付きS3価格表の読み込み
- `pricing-verifier/`: 警告専用の定期価格照合
- `scripts/deploy.mjs`: JSON configの検証と`cdkdep`固定デプロイ

CloudWatchの費用・トークン数Dashboardは`costDashboardEnabled`で作成を選択できます。現行サンプルでは無効です。ログ本文の出力可否は用途別にconfigで制御できます。

## ドキュメント

- [コスト制御設計](doc/cost-control-design.md)
- [モデル価格表と照合方針](doc/pricing-api-strategy.md)
- [デプロイ手順](doc/deployment-guide.md)
- [デプロイ設定一覧](doc/deployment-context-options.md)
- [カスタムドメインのデプロイ手順](doc/custom-domain-deployment.md)
- [Bedrockモデル利用契約の事前準備](doc/model-access-prerequisites.md)
- [リソース命名設計](doc/resource-naming.md)
- [Runtime機能](doc/runtime-features.md)
- [UI機能](doc/ui-features.md)
- [セキュリティと運用上の境界](doc/security-notes.md)
- [フォルダ構成](doc/folder-structure.md)
- [セキュリティドキュメント](SECURITY.md)

## 制約

- 月額上限は対応モデルの入力・出力トークン費用を対象とするソフト上限です。税、割引、為替、無料枠は計算へ含めません。
- AgentCore Runtime、Memory、Gateway、Knowledge Base、Lambda、DynamoDB、KMS、CloudFront、CloudWatchなど、モデル以外の費用は上限対象外です。
- 予約を持たないため、同時に開始した呼び出しの実費分だけ月額上限を超える可能性があります。
- Hosted Zone、ACM証明書、Entraアプリ、GeminiとEntraのシークレットはスタック外で管理します。
- WAF、短時間レート制限、Bedrock Guardrails、管理画面は含みません。

## ライセンス

[MIT License](LICENSE)
