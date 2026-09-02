# デプロイ設定一覧

最終更新日: 2026-09-02

このプロジェクトのデプロイ設定は、Git管理外の`scripts/deploy-config.psd1`へ集約します。CDKの`-c`を手入力すると再デプロイ時に値を落としやすいため、通常は`scripts/Deploy-Workmate.ps1`を使用します。

```powershell
Copy-Item .\scripts\deploy-config.example.psd1 .\scripts\deploy-config.psd1
.\scripts\Deploy-Workmate.ps1
```

## 基本設定

| 設定キー | 必須条件 | 用途・制約 |
|---|---|---|
| `Profile` | 常時 | AWS CLI/CDKプロファイル |
| `Region` | 常時 | 配置リージョン。現在の構成は`us-east-1` |
| `ResourceNamePrefix` | 常時 | 明示名を持つプロジェクト固有AWSリソースの接頭辞。小文字英数字とハイフン、1～32文字 |
| `UiName` | 常時 | 画面上のエージェント名とブラウザタイトル。1～64文字 |
| `KnowledgeBaseId` | 常時 | 既存Bedrock Knowledge Base ID。10文字の大文字英数字 |
| `CognitoDomainPrefix` | 常時 | Cognito Hosted UIの一意なプレフィックス。アプリ配信用ドメインではない |
| `WebDebugMode` | 常時 | `on` / `off`。本番は`off` |

`ResourceNamePrefix = "workmate"`はLambda関数、AgentCore Gateway、KMS Alias、AgentCore Runtime名、費用台帳のプロジェクトIDへ使う。タグに対応するスタック内リソースには`CostGroup=workmate`も付与し、Cost ExplorerやCost and Usage Reportの集計軸として使えるようにする。CloudFormationが自動生成するS3 Bucket、DynamoDB Table、Log Groupの物理名は対象外である。Cognito提供ドメインは全AWSアカウントで一意にする必要があるため、`CognitoDomainPrefix`で別に指定する。

既存環境で`ResourceNamePrefix`を変更すると、名前を変更できないAWSリソースが置換される。初回デプロイ後は環境識別子として固定し、変更が必要な場合は新規スタックとして構築する。`UiName`の変更はWeb配布物と説明文だけを更新する。

`CostGroup`をCost ExplorerやCost and Usage Reportで使うには、デプロイ後にBilling and Cost Managementの「Cost allocation tags」でユーザー定義タグを有効化する。タグキーが有効化画面へ現れるまでと、有効化が反映されるまでに、それぞれ最大24時間かかる場合がある。詳細は[AWS公式手順](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html)を参照する。

## カスタムドメイン

| 設定キー | 必須条件 | 用途・制約 |
|---|---|---|
| `CustomDomainEnabled` | 常時 | `$true` / `$false` |
| `CustomDomainName` | 有効時 | 例: `cost-control.example.com`。Hosted Zone直下または配下のサブドメイン |
| `HostedZoneId` | 有効時 | 既存Route 53 Hosted Zone ID |
| `HostedZoneName` | 有効時 | 既存Hosted Zone名 |
| `CertificateArn` | 有効時 | CloudFront用として`us-east-1`で発行済みのACM証明書ARN |

`CustomDomainEnabled = $false`では、CloudFront標準の`*.cloudfront.net` URLをアプリURL、Cognito callback URL、logout URLに使用します。この場合、残り4項目が空やプレースホルダーでもエラーにしません。

`$true`では4項目を必須検証し、CloudFrontへ証明書とAlternate Domain Nameを設定します。既存Hosted ZoneとACM証明書は参照だけで、スタックが管理するのはCloudFrontとAlias Aレコードです。

## 認証方式

| 設定キー | 必須条件 | 用途・制約 |
|---|---|---|
| `EntraEnabled` | 常時 | `$true` / `$false` |
| `EntraTenantId` | Entra有効時 | Microsoft EntraテナントID |
| `EntraClientId` | Entra有効時 | EntraアプリのクライアントID |
| `EntraClientSecretName` | Entra有効時 | Secrets Manager名。シークレット本文は設定ファイルへ書かない |
| `LoginMethods` | 常時 | `cognito` / `entra` / `cognito-and-entra`。Entraを含む値は`EntraEnabled = $true`が必要 |

## ログ

| 設定キー | 指定値 | 既定・注意 |
|---|---|---|
| `LogRetentionDays` | CloudWatch Logs対応日数 | 既定3日 |
| `RuntimeLogRequest` | `on` / `off` | 入力本文を含むため機密環境では`off`を検討 |
| `RuntimeLogModel` | `on` / `off` | 応答本文を含むため機密環境では`off`を検討 |
| `RuntimeLogTool` | `on` / `off` | ツール引数と結果を含む |

## 費用上限とユーザー上限

| 設定キー | 用途・制約 |
|---|---|
| `AccountMonthlyBudgetUsd` | AWSアカウント単位の月額LLM費用上限。0より大きく小数9桁まで |
| `ProjectMonthlyBudgetUsd` | このRuntimeのプロジェクト単位の月額LLM費用上限。同上 |
| `UserLimitProfiles` | ユーザー単位トークン上限プロファイルの配列 |

```powershell
UserLimitProfiles = @(
  @{ id = "default"; default = $true;  window = "monthly"; tokenLimit = 1000000 }
  @{ id = "weekly";  default = $false; window = "weekly";  tokenLimit = 250000 }
  @{ id = "daily";   default = $false; window = "daily";   tokenLimit = 50000 }
)
```

- `id`: 小文字英数字とハイフン、最大48文字。一意であること
- `default`: `$true`は必ず1件
- `window`: `daily` / `weekly` / `monthly`
- `tokenLimit`: 正の安全な整数

デプロイスクリプトは配列をJSONへ変換し、WindowsのPowerShell→npm→CDK間で引用符が失われないようBase64URLで`userLimitProfilesBase64`コンテキストへ渡します。CDKは復号後に全項目を再検証し、Runtimeには通常のJSONとして`USER_LIMIT_PROFILES_JSON`を渡します。Base64URLは秘匿化ではありません。

## CDKへ渡されるコンテキスト

| 設定ファイル | CDKコンテキスト |
|---|---|
| `CustomDomainEnabled` | `customDomainEnabled` |
| `ResourceNamePrefix` | `resourceNamePrefix` |
| `UiName` | `uiName` |
| `CustomDomainName` | `customDomainName` |
| `HostedZoneId` | `hostedZoneId` |
| `HostedZoneName` | `hostedZoneName` |
| `CertificateArn` | `certificateArn` |
| `EntraEnabled`ほか認証設定 | 対応するlower camel case名 |
| ログ設定 | 対応するlower camel case名 |
| 費用上限 | `accountMonthlyBudgetUsd` / `projectMonthlyBudgetUsd` |
| `UserLimitProfiles` | `userLimitProfilesBase64` |

値の取得方法とデプロイ後の確認は[デプロイ手順書](deployment-guide.md)、ドメイン固有の作業は[カスタムドメインのデプロイ手順](custom-domain-deployment.md)を参照する。
