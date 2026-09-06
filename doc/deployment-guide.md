# デプロイ手順書

本サンプルのローカル検証、AWSへのデプロイ、Cognito利用者の作成、Microsoft Entra ID連携、運用確認、削除までを扱う。設定項目の全一覧は[デプロイ設定リファレンス](./deployment-context-options.md)、リソース名の生成規則は[リソース命名設計](./resource-naming.md)を参照する。

## 前提

- Node.js 24
- AWS CLI v2とAWS CDK
- PowerShell 7
- CDK bootstrap済みのAWS環境
- デプロイ権限を持つAWS CLIプロファイル`cdkdep`
- 参照用`default`、Cognito利用者やSecrets ManagerなどCDK管理外の変更用`admin`プロファイル
- Geminiを使う場合はAPIキーをSecrets Managerへ登録済み
- 独自ドメインを使う場合はRoute 53 Hosted Zoneと`us-east-1`のACM証明書を作成済み
- Entra IDを使う場合はテナント管理権限と`Microsoft.Graph.Authentication` PowerShellモジュール

第三者モデルを有効化する前に、[Bedrockモデル利用契約の事前準備](./model-access-prerequisites.md)に従ってアカウント側の契約と利用可否を確認する。この操作はCDK管理外とする。

## ローカル検証

```powershell
npm ci
npm run runtime:install
npm run verify
```

`public/runtime-config.json`はデプロイ時に実値へ置き換わる。未デプロイのローカル環境へAWSの実値を暗黙に補完しないため、実際の認証とモデル呼び出しはデプロイ後に確認する。

## configを作成する

米国東部リージョンの例:

```powershell
Copy-Item .\scripts\deploy-config.us-east-1.example.json .\scripts\deploy-config.json
```

東京リージョンの例:

```powershell
Copy-Item .\scripts\deploy-config.ap-northeast-1.example.json .\scripts\deploy-config.json
```

`deploy-config.json`はGit管理外である。次のサンプル値を実環境へ合わせる。

- Knowledge Base ID
- カスタムドメイン、Hosted Zone、証明書ARN
- Gemini APIキーを格納したSecrets Manager名
- 有効化するモデル
- 月額上限とログ保持期間

複数のKnowledge BaseとGateway Lambdaターゲットは、それぞれ`knowledgeBases`と`gatewayTargets`の配列へ追加する。Cognito提供ドメインはCloudFormation Stack IDから安定生成されるため、configでは指定しない。

独自ドメインを使う場合の証明書確認、DNS検証、切り戻しは[カスタムドメインのデプロイ手順](./custom-domain-deployment.md)を参照する。

## デプロイする

最初にJSONの検証とCloudFormation差分を確認する。

```powershell
npm run deploy:test
npm run deploy:diff
```

問題がなければ反映する。

```powershell
npm run deploy
```

`deploy:diff`と`deploy`はMJSスクリプトがJSONを検証し、CDKを`cdkdep`プロファイルで実行する。PowerShell固有のデプロイスクリプトは使用しない。

CDKはCloudFormation差分だけを更新する。Dockerのマルチステージビルドとは異なり、依存関係を含む単一スタックの変更セットとして適用される。価格表または月額上限だけを変更した場合は、通常は関連するS3アセット、DynamoDB設定用カスタムリソース、必要なRuntime設定だけが更新され、無関係な物理リソースは作り直されない。

AWSリソースを手作業で変更するとCDK定義とのドリフトが生じ、次回デプロイで上書きまたは競合する。CDK管理対象の設定はconfigまたはコードで変更する。

## Cognito利用者を作成する

Cognitoの自己サインアップは無効であり、CDKは初期利用者を作成しない。CDK管理外の利用者作成には一時的な`admin`認証を使用する。

```powershell
aws login --profile admin
npm run cognito:user:create -- --email <利用者メールアドレス> --profile admin --region <AWS_REGION>
aws logout --profile admin
```

スクリプトはStack OutputからUser Pool IDを取得し、24文字のランダムな恒久パスワードを設定する。ログインIDとパスワードは標準出力へ一度だけ表示されるため、安全な保管先へ記録する。既存利用者のパスワード再発行には`npm run cognito:user:set-password`を使う。

## オプション: Microsoft Entra IDを有効にする

Entra連携はOIDC Authorization Code Flowである。CognitoがEntraのconfidential Web clientとなり、ブラウザはCognitoのpublic App ClientをPKCEで利用する。アプリからMicrosoft Graph APIは呼ばず、認証に使う委任スコープは`openid email`だけとする。

EntraアプリとクライアントシークレットはCDK管理外である。テナント管理者が作成、同意、利用者割り当て、ローテーション、削除を管理する。

### 1. Cognitoのみで一度デプロイする

Entraへ登録するリダイレクトURIにはCognito提供ドメインが必要になる。まず`deploy-config.json`を次の状態でデプロイする。

```json
{
  "entraEnabled": false,
  "loginMethods": "cognito"
}
```

実際には既存JSONの該当キーを変更し、他の必須項目を残す。デプロイ後、CloudFormation OutputからCognitoドメインを取得する。

```powershell
$region = "<AWS_REGION>"
$cognitoHost = aws cloudformation describe-stacks `
  --stack-name AgentCoreCostControlStack `
  --profile default `
  --region $region `
  --query "Stacks[0].Outputs[?OutputKey=='CognitoDomain'].OutputValue | [0]" `
  --output text

$cognitoHost
```

値が`None`または空なら後続作業へ進まない。

### 2. Entraアプリとシークレットを作成する

Microsoft Graphモジュールが未導入なら、現在の利用者向けに導入する。

```powershell
Install-Module Microsoft.Graph.Authentication -Scope CurrentUser
```

実環境の値を設定し、Graphへ接続する。

```powershell
$tenantId = "<Entra tenant GUID>"
$appDisplayName = "<Entra application display name>"

Connect-MgGraph `
  -TenantId $tenantId `
  -Scopes 'Application.ReadWrite.All','Application.Read.All','DelegatedPermissionGrant.ReadWrite.All' `
  -ContextScope Process `
  -NoWelcome
```

同梱スクリプトは、単一テナントのアプリ登録、Enterprise Application、180日有効なクライアントシークレットを作る。Enterprise Applicationは利用者割り当て必須、My Apps非表示となる。

```powershell
$created = & ".\scripts\entra\New-EntraCognitoOidcApplication.ps1" `
  -TenantId $tenantId `
  -DisplayName $appDisplayName `
  -CognitoUserPoolDomainHost $cognitoHost

$appClientId = $created.ApplicationClientId
```

`$created.ClientSecret`はこの時だけ取得できる。リポジトリ、JSON config、CloudFormationパラメータ、作業メモへ本文を記載しない。

### 3. 管理者同意と利用者割り当てを行う

要求済みの`openid email`へテナント全体の管理者同意を与える。

```powershell
& ".\scripts\entra\Grant-EntraCognitoOidcAdminConsent.ps1" `
  -TenantId $tenantId `
  -ApplicationClientId $appClientId
```

同意と利用者割り当ては別の制御である。Entra管理センターの「エンタープライズ アプリケーション」から対象アプリを開き、ログインを許可する利用者またはグループを割り当てる。

### 4. シークレットをAWSへ保存する

シークレット名を決め、CDK管理外のSecrets Managerへ登録する。

```powershell
$secretName = "<Entra client secret name>"

aws login --profile admin
aws secretsmanager create-secret `
  --name $secretName `
  --secret-string $($created.ClientSecret) `
  --profile admin `
  --region $region
aws logout --profile admin
```

同名シークレットが既に存在する場合は、`create-secret`ではなく`put-secret-value --secret-id $secretName`を使う。AWSへの保存を確認したら、平文を保持するPowerShell変数を破棄する。

```powershell
Remove-Variable created -ErrorAction SilentlyContinue
Disconnect-MgGraph
```

### 5. JSON configでEntraを有効にする

`deploy-config.json`の該当部分を更新する。シークレット本文ではなくSecrets Manager名を指定する。

```json
{
  "entraEnabled": true,
  "entraTenantId": "<Entra tenant GUID>",
  "entraClientId": "<Entra application client ID>",
  "entraClientSecretName": "<Entra client secret name>",
  "loginMethods": "cognito-and-entra"
}
```

`loginMethods`は画面表示だけでなく、Cognito App Clientが許可する認証方式にも反映される。

| 値 | 許可するログイン |
|---|---|
| `cognito` | Cognitoのメールアドレスとパスワード |
| `entra` | Microsoft Entra IDのみ |
| `cognito-and-entra` | CognitoとMicrosoft Entra IDの両方 |

`entra`または`cognito-and-entra`を指定するには`entraEnabled=true`が必要である。Entra設定をJSONへ保存するため、再デプロイ時にCDKコンテキストを手入力し直す必要はない。

```powershell
npm run deploy:test
npm run deploy:diff
npm run deploy
```

### 6. Entra設定とログインを確認する

Entra側の登録内容を検査する。

```powershell
& ".\scripts\entra\Get-EntraCognitoOidcApplication.ps1" `
  -TenantId $tenantId `
  -ApplicationClientId $appClientId `
  -ExpectedCognitoUserPoolDomainHost $cognitoHost
```

`Checks`の各項目が`True`であることを確認する。続いてアプリを開き、割り当て済みの一般利用者でログイン、ログアウト、再ログインを確認する。本番導入前はグループ割り当てとトークン更新も含めてE2Eで検証する。

## プレースホルダは管理画面またはCLIで確認する

ガイドとサンプルJSONにある`<...>`やサンプルIDは、そのままデプロイしない。

| プレースホルダ | 決め方・確認元 |
|---|---|
| `<AWS_REGION>` | `deploy-config.json`の`region` |
| `<利用者メールアドレス>` | Cognitoへ作成する利用者のメールアドレス |
| Knowledge Base ID | Amazon BedrockのKnowledge Base一覧 |
| Hosted Zone ID・名前 | Route 53のHosted Zone一覧 |
| 証明書ARN | `us-east-1`のACM証明書一覧 |
| Gemini APIキーのシークレット名 | Secrets Managerのシークレット一覧 |
| `<Entra tenant GUID>` | Microsoft Entra管理センターのテナント概要 |
| `<verified-domain>` | Entraテナントの検証済みドメイン |
| `<Entra application display name>` | Entra内で重複しない表示名を決める |
| `<Entra application client ID>` | Entraアプリ登録の「アプリケーション（クライアント）ID」 |
| `<Entra client secret name>` | Secrets Managerで重複しない名前を決める |

### AWSのスタック出力をまとめて確認する

```powershell
$region = (Get-Content .\scripts\deploy-config.json -Raw | ConvertFrom-Json).region

aws cloudformation describe-stacks `
  --stack-name AgentCoreCostControlStack `
  --profile default `
  --region $region `
  --query "Stacks[0].Outputs" `
  --output table
```

個別の値は`OutputKey`で絞り込む。次はCognito提供ドメインの例である。

```powershell
aws cloudformation describe-stacks `
  --stack-name AgentCoreCostControlStack `
  --profile default `
  --region $region `
  --query "Stacks[0].Outputs[?OutputKey=='CognitoDomain'].OutputValue | [0]" `
  --output text
```

### AWS側の既存リソースを確認する

Knowledge Base ID:

```powershell
aws bedrock-agent list-knowledge-bases `
  --profile default `
  --region $region `
  --query "knowledgeBaseSummaries[].{name:name,id:knowledgeBaseId,status:status}" `
  --output table
```

Hosted Zone IDと名前:

```powershell
aws route53 list-hosted-zones `
  --profile default `
  --query "HostedZones[].{name:Name,id:Id}" `
  --output table
```

CloudFront用ACM証明書ARN:

```powershell
aws acm list-certificates `
  --profile default `
  --region us-east-1 `
  --certificate-statuses ISSUED `
  --query "CertificateSummaryList[].{domain:DomainName,arn:CertificateArn}" `
  --output table
```

Secrets Managerの名前だけを確認する。シークレット本文は取得しない。

```powershell
aws secretsmanager list-secrets `
  --profile default `
  --region $region `
  --query "SecretList[].Name" `
  --output table
```

### EntraのテナントIDとクライアントIDを確認する

テナントIDはMicrosoft Entra管理センターの「概要」で確認する。テナントの検証済みドメインが分かる場合は、OpenID Connectのディスカバリ文書からも取得できる。

```powershell
$openidConfiguration = Invoke-RestMethod "https://login.microsoftonline.com/<verified-domain>/v2.0/.well-known/openid-configuration"
[regex]::Match($openidConfiguration.issuer, '[0-9a-fA-F-]{36}').Value
```

クライアントIDを作成後に確認する場合は、Entra管理センターの「アプリの登録」を使う。Microsoft Graphから表示名で検索する場合は次を実行する。

```powershell
Connect-MgGraph -TenantId "<Entra tenant GUID>" -Scopes 'Application.Read.All' -ContextScope Process -NoWelcome

$displayName = "<Entra application display name>"
$escapedDisplayName = $displayName.Replace("'", "''")
$filter = [Uri]::EscapeDataString("displayName eq '$escapedDisplayName'")
Invoke-MgGraphRequest `
  -Method GET `
  -Uri "https://graph.microsoft.com/v1.0/applications?`$filter=$filter&`$select=appId,displayName"

Disconnect-MgGraph
```

クライアントシークレット本文は作成時しか表示されない。紛失した場合は既存値を検索せず、`New-EntraCognitoOidcClientSecret.ps1`で再発行してSecrets Managerを更新する。

## デプロイ後の確認

CloudFormation OutputsからアプリURL、Runtime ARN、Cognito User Pool、費用台帳、価格表Bucket、CloudWatch Dashboard名を確認する。`priceVerificationEnabled=true`なら価格照合Lambda名も出力される。

1. configで許可した認証方式でログインする。
2. 有効化したBedrockモデルとGeminiで応答を確認する。
3. 各Knowledge BaseとGateway Lambdaツールを呼び分ける。
4. CloudWatch Dashboardで費用とトークン数を確認する。
5. Runtime Logsで`model.cost.recorded`、価格表Version ID、適用単価を確認する。

### ブラウザデバッグを使う

AG-UIのSSE、認証更新、ツールイベントを調査するときだけ、`deploy-config.json`の`webDebugMode`を`on`へ変更して再デプロイする。通常運用は`off`とする。

デバッグログには会話本文、ツール引数、ツール結果、SSE本文が含まれる可能性がある。機密情報を扱うセッションでは有効にせず、共有前に内容を確認する。調査後は`off`へ戻して再デプロイする。

### DynamoDB費用台帳で当月の料金状況を確認する

読み取り専用の`default`プロファイルで、CloudFormation Outputsから費用台帳名と集計IDを解決し、当月の上限、確定費用、残額、消化率、利用結果、モデル別内訳を表示する。

```powershell
npm run budget:status -- --region=us-east-1
```

月はUTC基準で判定する。過去月を確認する場合は`--month YYYY-MM`、機械処理向けには`--json`を付ける。

```powershell
npm run budget:status -- --region=us-east-1 --month=2026-08 --json
```

一部のWindows PowerShell環境でnpmがオプション名を除いて値だけを転送する場合にも、`[region] [month]`の順で互換処理する。npmを介さず確実に名前付き引数を渡す場合は、次を使用する。

```powershell
node scripts/show-cost-status.mjs --region us-east-1 --month 2026-08 --json
```

確定費用には`APPLIED`だけが加算される。`NO_CHARGE`と`USAGE_UNAVAILABLE`は件数を分けて表示し、確定費用へ混ぜない。月次レコードと当月の`APPLIED`イベント合計が異なる場合は警告を表示する。

## 月途中の設定変更

`monthlyBudgetUsd`または価格表を変更し、`deploy:diff`で差分を確認してから再デプロイする。月額上限は次回の事前判定から、価格表は次回のモデル呼び出しから使われる。当月実績は年月キーで保持され、月が変わると新しいレコードへ切り替わる。

価格照合の不一致は警告であり、モデル呼び出しを停止しない。価格表修正が必要ならコード側の価格カタログを更新し、レビュー後に再デプロイする。

## ロールバック

コードまたはconfigを戻し、`deploy:diff`で差分を確認してから再デプロイする。S3価格表はVersioningされるが、Runtimeが参照するのはCDK配置先キーの現行版であるため、ロールバックもCDKで行う。

費用台帳の利用イベントと月次実績は運用記録なので、スタック更新のロールバックだけでは書き換えない。

## スタックを削除する

削除前にCloudFormation差分、Removal Policy、保持対象データを確認する。チャット履歴、費用台帳、ログなど、再利用または監査に必要なデータを誤って失わないようにする。

```powershell
npm run destroy
```

このコマンドは`cdkdep`プロファイルで`AgentCoreCostControlStack`を削除する。Entraアプリ、Entraのクライアントシークレット、既存Hosted Zone、ACM証明書などCDK管理外のリソースは削除されない。不要になった場合は、それぞれの管理者が別途削除する。
