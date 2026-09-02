# Strands AgentCore + assistant-ui Cost Control

Amazon Bedrock AgentCore Runtime、Strands Agents、AG-UI、assistant-uiで構成したチャットアプリケーションのサンプルです。全8モデルで最大出力の費用をDynamoDBへ事前予約し、入力費用を応答usageから実行後に加算して、アカウント・プロジェクト・ユーザーの上限を適用します。

## 特徴

- Amazon Cognitoによる認証と、任意のMicrosoft Entra ID OIDC連携
- AgentCore Runtimeとブラウザ間のAG-UIストリーミング
- AgentCore Memoryを使った会話履歴とユーザー単位の長期記憶
- AgentCore Gateway経由のMCPツール呼び出し
- アカウント／プロジェクトのソフト月額制限
- ユーザー単位の日次／週次／月次トークン上限
- DynamoDB Transactionによる予約・精算と並行実行時の上限保護
- AWS Price List Query APIによるモデル単価の日次自動照合
- `CostGroup`タグによるプロジェクト単位のAWSコスト集計

## 費用上限の仕組み

```text
モデル呼び出し
  -> DynamoDB価格マスタと有効期限を検証
  -> 全モデルで最大出力から予約額を計算
  -> DynamoDB TransactionでACCOUNT / PROJECT / USER / requestを予約
  -> Bedrock ConverseStreamを実行
  -> 応答usageの実費で精算し、予約差額を返却
```

全8モデルで最大出力分を事前予約し、入力分を応答usageから実行後に加算します。そのため、受け付けた1回の呼び出しで上限を超える可能性があります。Bedrock送信後にusageを確認できない場合は、実課金の可能性があるため予約を自動解放しません。制御対象、予約・精算、台帳、障害時動作は[コスト制限設計](doc/cost-control-design.md)を参照してください。

既定値は次のとおりです。

- このスタックの台帳内におけるAWSアカウントID: 100 USD／月
- プロジェクト: 60 USD／月
- ユーザー: 割り当てプロファイルの日次・週次・月次トークン数

期間境界はUTCです。金額は整数nano USD、ユーザー使用量は整数トークンで記録します。

## 必要環境

- Node.js 24
- npm 10以降
- AWS CLI
- AWS CDK CLI
- PowerShell 7以降
- 対象AWSアカウントで必要なサービスを作成できる認証情報

利用する主なAWSサービスと必要な事前設定は[デプロイ手順](doc/deployment-guide.md)を参照してください。

## セットアップと検証

```powershell
npm ci
npm run runtime:install
npm run verify
```

`npm run verify`はフロントエンドとRuntimeの型検査、lint、単体テスト、ビルド、Gatewayテスト、CDK synthを実行します。

## デプロイ設定

設定例をGit管理外の実設定へコピーします。

```powershell
Copy-Item .\scripts\deploy-config.example.psd1 .\scripts\deploy-config.psd1
```

最低限、リソース接頭辞、UI名、予算、Cognitoドメインプレフィックスを設定します。独自ドメインを使う場合は、例示されたplaceholderを自分の環境の値へ置き換えてください。

```powershell
@{
  Profile                 = "default"
  Region                  = "us-east-1"
  ResourceNamePrefix      = "workmate"
  UiName                  = "Workmate"
  CognitoDomainPrefix     = "<unique-domain-prefix>"
  AccountMonthlyBudgetUsd = "100"
  ProjectMonthlyBudgetUsd = "60"
  CustomDomainEnabled     = $false
  CustomDomainName        = "<app-subdomain.example.com>"
  HostedZoneId            = "<route53-hosted-zone-id>"
  HostedZoneName          = "<example.com>"
  CertificateArn          = "<us-east-1-acm-certificate-arn>"
}
```

`ResourceNamePrefix`は明示名を持つAWSリソースと費用台帳のプロジェクトIDへ使い、タグ対応リソースへ`CostGroup=<ResourceNamePrefix>`を付与します。`UiName`は画面上のエージェント名とブラウザタイトルです。Cognito提供ドメインとアプリ公開ドメインはそれぞれ独立して設定します。

デプロイします。

```powershell
.\scripts\Deploy-Workmate.ps1
```

詳細な設定、Cognitoユーザー作成、Microsoft Entra ID連携、削除手順は[デプロイ手順](doc/deployment-guide.md)にあります。

## 主な実装

- `runtime/src/model-factory.ts`: モデル呼び出しの予約と精算
- `runtime/src/token-counter.ts`: モデル別トークン計数
- `runtime/src/cost.ts`: トークン単価とnano USD計算
- `runtime/src/budget-ledger.ts`: DynamoDB Transactionによる台帳更新
- `runtime/src/pricing-catalog.ts`: 価格マスタの強整合読み取りとfail-closed検証
- `pricing-verifier/index.py`: AWS Price List Query APIとの日次照合
- `shared/user-limit-profiles.ts`: ユーザー上限プロファイルとUTCウィンドウ計算
- `shared/initial-model-pricing.ts`: 初回デプロイ用の価格マスタ
- `infrastructure/stack.ts`: Runtime、認証、記憶、Gateway、費用台帳、配信基盤

## ドキュメント

- [コスト制限設計](doc/cost-control-design.md)
- [モデル価格調査APIと自動照合方針](doc/pricing-api-strategy.md)
- [デプロイ手順](doc/deployment-guide.md)
- [デプロイ設定一覧](doc/deployment-context-options.md)
- [カスタムドメインのデプロイ手順](doc/custom-domain-deployment.md)
- [Runtime機能](doc/runtime-features.md)
- [UI機能](doc/ui-features.md)
- [セキュリティ上の注意](doc/security-notes.md)
- [フォルダ構成](doc/folder-structure.md)
- [セキュリティドキュメント](SECURITY.md)

## 制約

- 上限対象は対応モデルのトークン費用です。税、割引、AgentCore、Memory、Gateway、Lambdaなどの費用は含みません。
- モデル単価はDynamoDB価格マスタで管理し、AWS Price List Query APIとの日次照合に失敗して確認期限が切れたモデルは呼び出しません。
- Hosted ZoneとACM証明書はスタック外で管理します。
- prompt cacheは未設定です。cache usageが返った場合は精算を停止します。
- プロファイル管理画面、残留予約の照合ジョブ、AWS請求額との事後照合は未実装です。
- 実装済み統制と残存リスクは[SECURITY.md](SECURITY.md)を確認してください。

## ライセンス

[MIT License](LICENSE)
