# Strands AgentCore + assistant-ui Cost Control

Amazon Bedrock AgentCore Runtime、Strands Agents、AG-UI、assistant-uiで構成したチャットアプリケーションのサンプルです。Amazon Bedrockのモデル呼び出し前に最大費用をDynamoDBへ予約し、アカウント・プロジェクト・ユーザーの上限を原子的に適用します。

## 特徴

- Amazon Cognitoによる認証と、任意のMicrosoft Entra ID OIDC連携
- AgentCore Runtimeとブラウザ間のAG-UIストリーミング
- AgentCore Memoryを使った会話履歴とユーザー単位の長期記憶
- AgentCore Gateway経由のMCPツール呼び出し
- アカウント／プロジェクトの月額費用hard limit
- ユーザー単位の日次／週次／月次トークン上限
- DynamoDB Transactionによる予約・精算と並行実行時の上限保護

## 費用上限の仕組み

```text
モデル呼び出し
  -> モデル別のトークン計数経路を確定
  -> 入力トークン + 最大出力トークンから最大費用を計算
  -> DynamoDB TransactionでACCOUNT / PROJECT / USER / requestを予約
  -> Bedrock ConverseStreamを実行
  -> 応答usageの実費で精算し、予約差額を返却
```

`CountTokens`に失敗した場合は推定値へフォールバックせず、モデル呼び出しを停止します。Bedrock送信後にusageを確認できない場合は、実課金の可能性があるため予約を自動解放しません。

既定値は次のとおりです。

- AWSアカウント全体: 100 USD／月
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

最低限、予算とCognitoドメインプレフィックスを設定します。独自ドメインを使う場合は、例示されたplaceholderを自分の環境の値へ置き換えてください。

```powershell
@{
  Profile                 = "default"
  Region                  = "us-east-1"
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
- `shared/user-limit-profiles.ts`: ユーザー上限プロファイルとUTCウィンドウ計算
- `infrastructure/stack.ts`: Runtime、認証、記憶、Gateway、費用台帳、配信基盤

## ドキュメント

- [デプロイ手順](doc/deployment-guide.md)
- [Runtime機能](doc/runtime-features.md)
- [UI機能](doc/ui-features.md)
- [セキュリティ上の注意](doc/security-notes.md)
- [フォルダ構成](doc/folder-structure.md)
- [セキュリティドキュメント](SECURITY.md)

## 制約

- 上限対象は対応モデルのトークン費用です。税、割引、AgentCore、Memory、Gateway、Lambdaなどの費用は含みません。
- 単価表は`shared/model-catalog.ts`の固定値です。期限切れ単価のモデルは呼び出しません。
- Hosted ZoneとACM証明書はスタック外で管理します。
- prompt cacheは未設定です。cache usageが返った場合は精算を停止します。
- プロファイル管理画面、予約障害の照合ジョブ、AWS請求との自動照合は未実装です。
- 実装済み統制と残存リスクは[SECURITY.md](SECURITY.md)を確認してください。

## ライセンス

[MIT License](LICENSE)
