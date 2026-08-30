# デプロイ手順書

本サンプルのローカル検証からデプロイ、ユーザー上限プロファイル割り当て、カスタムドメイン、Entra ID連携、削除までの手順をまとめます。
プロジェクトの概要と構成は[README](../README.md)を参照してください。

前提はNode.js 24、npm、AWS CLI v2、PowerShell 7、`us-east-1`へデプロイできるAWSプロファイル、CDK bootstrap済み環境です。設定項目は`scripts/deploy-config.example.psd1`を参照してください。

## ローカル検証

```bash
npm ci
npm run verify
```

`public/runtime-config.json`は未デプロイ時に空値です。AWSの実値へフォールバックしないため、`npm run dev`だけでは認証画面を起動せず、設定不足を明示します。実画面のE2Eはデプロイ後に行います。

## 再デプロイ用のローカル設定

CDKコンテキストは前回値を保持しません。Entra設定などの指定漏れを防ぐため、exampleをGit管理外の設定へコピーします。

```powershell
Copy-Item .\scripts\deploy-config.example.psd1 .\scripts\deploy-config.psd1
```

`deploy-config.psd1`のプレースホルダーをデプロイ済み環境の値へ置き換える。このファイルは`.gitignore`対象となる。`Region`は`us-east-1`、`WebDebugMode`は`off`。クライアントシークレット本文は記載せず、Secrets Managerのシークレット名だけを設定する。

ユーザー上限プロファイルは`UserLimitProfiles`へ定義します。`default = $true`は必ず1件だけ必要です。`window`は`daily`、`weekly`、`monthly`のいずれか、`tokenLimit`は正の整数です。日・週・月の境界はUTCで、週次は月曜00:00 UTCに開始します。

独自ドメイン連携は`CustomDomainEnabled`で切り替えます。証明書発行前は次の設定でCloudFront標準URLを使用できます。

```powershell
CustomDomainEnabled = $false
```

独自ドメインを有効にする場合は次の5値を設定します。

```powershell
CustomDomainEnabled = $true
CustomDomainName = "cost-control.example.com"
HostedZoneId = "<route53-hosted-zone-id>"
HostedZoneName = "example.com"
CertificateArn = "<us-east-1で発行済みの*.example.com証明書ARN>"
```

`CustomDomainEnabled = $true`のときだけ残り4値を必須検証します。`$false`なら証明書ARNが空またはプレースホルダーでもデプロイを妨げません。Hosted ZoneとACM証明書はCloudFormation管理外です。証明書はCloudFrontの要件により`us-east-1`で発行し、`ISSUED`になってからARNを設定します。CDKは既存Hosted Zoneへ`cost-control.example.com`のAlias Aレコードを作り、CloudFront Distributionを参照先にします。

通常の再デプロイ:

```powershell
.\scripts\Deploy-Workmate.ps1
```

ブラウザデバッグを有効にする場合は、`deploy-config.psd1`を`WebDebugMode = "on"`へ変更して同じコマンドを実行する。

```powershell
.\scripts\Deploy-Workmate.ps1
```

スクリプトはプロファイル、リージョン、CDKコンテキストを設定ファイルから読み、必須値の空欄やexampleのプレースホルダーをビルド前に拒否する。別の設定ファイルを使う場合だけ`-ConfigPath`を明示する。

## 標準: Cognitoのみ

CDKは新しいUser Pool、public App Client、AWS提供Cognitoドメインを作ります。匿名アクセスはありません。Cognitoドメインは`cost-control-<AWS account ID>`です。アプリURLは独自ドメインONなら`https://cost-control.example.com/`、OFFならCloudFront標準URLです。Cognitoドメインはログイン処理用で、SPAの配信先ではありません。

AWSログイン後に実行します。

```powershell
aws login --profile admin
.\scripts\Deploy-Workmate.ps1
```

デプロイスクリプトは証明書ARNを含む必須値にプレースホルダーが残っていれば、CDK実行前に停止します。

デプロイ後、初期ユーザーと恒久パスワードを作ります。

```powershell
npm run cognito:user:create -- --email user@example.com --limit-profile weekly --profile default
```

`user@example.com`は作成したい初期ユーザーのメールアドレスです。Cognito側の検証済み属性として登録されるだけで、実際にメールは送信されません。

既存ユーザーの割り当てを変更する場合は次を実行します。CDKが作成した`workmate-limit-<profileID>` Cognitoグループへ1つだけ所属させます。

```powershell
npm run cognito:user:set-limit-profile -- --email user@example.com --limit-profile daily --profile default
```

新しい割り当ては既存のアクセストークンには反映されないため、対象ユーザーは再ログインします。グループ未所属は既定プロファイル、複数所属や削除済みプロファイルIDは安全側で実行拒否となります。

スクリプトが表示するパスワードは安全な保管先へ移し、ターミナル履歴の取り扱いに注意してください。

### デプロイ済みフロントURLを確認する

CloudFormationのスタック出力から独自URLを確認します。

```powershell
aws cloudformation describe-stacks `
  --stack-name WorkmateCostControlStack `
  --region us-east-1 `
  --query "Stacks[0].Outputs[?OutputKey=='ApplicationUrl'].OutputValue | [0]" `
  --output text
```

### Gatewayツールを確認する

ログイン後、チャットで次のように依頼します。

```text
サポート部門の問い合わせメールアドレスと営業時間を確認して
```

ツール実行欄に`SupportDirectory___lookup_support_contact`が表示され、`support@example.com`と営業時間が返ればRuntime → AgentCore Gateway → Lambdaの経路は正常です。Gateway URLとターゲットIDはCloudFormation出力`ToolGatewayUrl`、`SupportDirectoryTargetId`でも確認できます。

### ブラウザデバッグモード

AG-UIのSSE、初回履歴取得、認証更新、ツールイベントなどをブラウザ開発者ツールで確認するときだけ有効にします。既定はOFFです。

Cognitoのみの構成でONにする場合は、`deploy-config.psd1`の設定を変更してデプロイする。

```powershell
# scripts/deploy-config.psd1内
@{
  # 他の設定は省略
  WebDebugMode = "on"
}
```

```powershell
.\scripts\Deploy-Workmate.ps1
```

デバッグを終了したら、設定をOFFへ戻して再デプロイする。

```powershell
# scripts/deploy-config.psd1内
@{
  # 他の設定は省略
  WebDebugMode = "off"
}
```

```powershell
.\scripts\Deploy-Workmate.ps1
```

`WebDebugMode`は`on`で有効、`off`で無効となる。それ以外の値やキーの省略は実行前に拒否する。

Entra IDを有効にしている環境では、`deploy-config.psd1`のEntra設定を毎回自動的に渡します。`EntraEnabled = $true`のときに必須値が欠けていればデプロイ前に停止します。

デプロイ後、設定画面の「接続」タブで`Browser debug`が`ON`になっていることを確認します。開発者ツールのConsoleで`Workmate debug`を検索し、「ログを保持（Preserve log）」を有効にしてから新しいタブでページを開きます。

主なログ:

| Consoleイベント | 内容 |
|---|---|
| `app.config.loaded` | 配信されたRuntime設定とデバッグ状態 |
| `auth.session.loaded` | Access Tokenが存在するか。トークン本文は出さない |
| `history.request` / `history.response` | スレッド一覧・メッセージ取得・削除 |
| `http.request` / `http.response` | URL、HTTP状態、Content-Type、request ID |
| `http.response.body` | JSONまたはSSEの生レスポンス本文プレビュー |
| `[HTTP] Stream format detected` | AG-UIクライアントが判定したSSE／Protobuf形式 |
| `[SSE] Event received` | 解析済みAG-UIイベント |
| `assistant-ui` | Runtimeのイベント処理と警告 |
| `ag-ui.runtime.error` | `RUN_ERROR`またはプロトコル解析エラー |
| `window.error` / `window.unhandledrejection` | 未処理のブラウザ例外 |

Authorization、JWT、token、secret、passwordというキー、Base64添付データはマスクします。一方、会話本文、履歴、ツール引数・結果、SSE本文はデバッグに必要なためConsoleへ表示されます。機密情報を扱うセッションでは有効にせず、採取したログを共有する前に内容を確認してください。

## オプション: Cognito + Microsoft Entra ID

> Entra連携にはテナント管理者の権限と管理者同意が必要です。
> 本番導入前に、利用するテナントで一般ユーザー、グループ割り当て、ログアウト、
> トークン更新を含むE2E検証を実施してください。

Entra連携はOIDC Authorization Code Flowです。CognitoがEntraのconfidential Web clientとなり、ブラウザはCognitoのpublic App ClientをPKCEで利用します。Microsoft Graph APIをアプリから呼ばないため、Entraスコープは`openid email`だけです。

### 0. Microsoft Graphへ一度だけ接続する

以降の手順で繰り返し使う値を、先に変数へ入れておきます。**`<...>`の部分は実際の値に置き換えてください。**そのまま実行すると`Invalid tenant id provided.`のようなエラーになります。値の調べ方は[プレースホルダの確認方法](#プレースホルダの確認方法)を参照してください。

```powershell
$tenantId = "<Entra tenant GUID>"
$appDisplayName = "workmate-codezip"
$domainPrefix = "<unique-domain-prefix>"
```

`scripts/entra`のスクリプトは、既存のMicrosoft Graphセッションがあればそれを再利用します。手順の最初に一度接続しておけば、スクリプトを実行するたびにブラウザ認証を求められることはありません。

```powershell
Connect-MgGraph -TenantId $tenantId -Scopes 'Application.ReadWrite.All','Application.Read.All','DelegatedPermissionGrant.ReadWrite.All' -ContextScope Process -NoWelcome
```

指定するスコープは`scripts/entra`配下のスクリプトが要求するものの和集合です。不足したまま実行すると、Graph呼び出しが失敗する前にスクリプトが不足スコープ名を挙げて停止します。

接続状態は次で確認できます。

```powershell
Get-MgContext | Select-Object TenantId, Account, Scopes
```

Entraの手順（0から2）が終わったら切断します。

```powershell
Disconnect-MgGraph
```

事前に接続しなかった場合、各スクリプトは自分で接続し、終了時に自分で切断します。その場合は実行のたびに認証が必要になります。

### 1. Entraアプリを作る

まずMicrosoft Entra管理センター（<https://entra.microsoft.com>）へ管理者でログインし、**アプリ登録の表示名を決めて控えておきます**。以降のスクリプトとポータル操作はこの名前でアプリを特定します。本READMEでは`workmate-codezip`を例に使います。

Cognitoのドメインホストが必要なので、先にスタック出力を確認します。

```powershell
aws cloudformation describe-stacks --stack-name WorkmateCostControlStack --region us-east-1 --query "Stacks[0].Outputs" --output table
```

作成方法は2通りあります。どちらか一方だけを実行してください。

#### 方法A: スクリプトで作成する

アプリ登録、サービスプリンシパル、クライアントシークレットをまとめて作ります。

```powershell
$cognitoHost = "$domainPrefix.auth.us-east-1.amazoncognito.com"

$created = & ".\scripts\entra\New-EntraCognitoOidcApplication.ps1" `
  -TenantId $tenantId `
  -DisplayName $appDisplayName `
  -CognitoUserPoolDomainHost $cognitoHost
```

作成されるEnterprise Applicationはユーザー割り当て必須・My Apps非表示です。

#### 方法B: Entra管理センターで手動作成する

1. Entra管理センターへログインし、「アプリの登録」→「新規登録」を開く
2. 「名前」に手順0で`$appDisplayName`へ入れた表示名（例: `workmate-codezip`）を入力する
3. 「サポートされているアカウントの種類」で「この組織ディレクトリのみに含まれるアカウント（単一テナント）」を選ぶ
4. 「リダイレクトURI」でプラットフォームに「Web」を選び、下記のURIを入力する
5. 登録後、「概要」に表示される**アプリケーション (クライアント) ID**を控える
6. 「証明書とシークレット」→「新しいクライアントシークレット」を作成し、**表示された値を控える**。この値は再表示できない

```text
https://<unique-domain-prefix>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
```

Entraへ登録するRedirect URIはこの1つだけです。ポータルへ貼り付ける実際の値は次で表示できます。

```powershell
"https://$domainPrefix.auth.us-east-1.amazoncognito.com/oauth2/idpresponse"
```

手動で作成した場合、`New-EntraCognitoOidcApplication.ps1`は同名アプリを検出して`An application with the same displayName already exists`で停止します。方法Bを選んだときはこのスクリプトを実行せず、次の2つで設定を揃えてください。

```powershell
$appClientId = "<application client ID>"

& ".\scripts\entra\Set-EntraCognitoOidcApiPermissions.ps1" `
  -TenantId $tenantId `
  -ApplicationClientId $appClientId

& ".\scripts\entra\Set-EntraCognitoEnterpriseApplicationProperties.ps1" `
  -TenantId $tenantId `
  -ApplicationClientId $appClientId
```

前者はAPIのアクセス許可を`openid`と`email`だけに揃え、後者はEnterprise Applicationをユーザー割り当て必須・My Apps非表示にします。

方法Bでは`$created`変数が存在しないため、以降の手順に出てくる`$($created.ApplicationClientId)`と`$($created.ClientSecret)`は、控えた値へ読み替えてください。

### 2. 管理者の同意をテナント全体へ与える

`New-EntraCognitoOidcApplication.ps1`と`Set-EntraCognitoOidcApiPermissions.ps1`は、Microsoft Graphの委任スコープ`openid`と`email`を**要求として登録するだけ**です。同意そのものは与えません。ポータルの「API のアクセス許可」には「付与されていません」と表示されたままになります。

この状態で一般ユーザーがログインすると、次のいずれかになります。

- 利用者ごとに同意画面が表示される
- テナントで「ユーザーの同意を許可しない」を設定している場合、同意画面すら出せずログインが失敗する

Enterprise Applicationへユーザーを割り当てても、この同意は代替できません。割り当ては「誰がこのアプリを使えるか」の制御であり、同意は「アプリがどの情報を読めるか」の許可だからです。したがって、管理者が事前にテナント全体の同意を与えておきます。

```powershell
# 方法Aで作成した場合。方法Bなら $appClientId をそのまま使う
$appClientId = $created.ApplicationClientId

$consent = & ".\scripts\entra\Grant-EntraCognitoOidcAdminConsent.ps1" `
  -TenantId $tenantId `
  -ApplicationClientId $appClientId
```

スクリプトはMicrosoft Graphの`oauth2PermissionGrants`へ`consentType: AllPrincipals`の付与を作成します。既に同じ付与がある場合はスコープを`openid email`へ更新します。付与後に再取得して、スコープが一致することを検証します。

実行には**Cloud Application Administrator以上のロール**が必要です。要求するGraphスコープは`Application.Read.All`と`DelegatedPermissionGrant.ReadWrite.All`です。

現在の同意状態だけを確認したい場合は`-WhatIf`を付けます。変更は行わず、`Phase = Before`の内容だけが出力されます。

```powershell
& ".\scripts\entra\Grant-EntraCognitoOidcAdminConsent.ps1" `
  -TenantId $tenantId `
  -ApplicationClientId $appClientId `
  -WhatIf
```

`GrantedScopes`に`openid`と`email`が並べば完了です。ポータル側では「API のアクセス許可」の状態が「<テナント名> に付与されました」に変わります。

なお`New-EntraCognitoOidcApplication.ps1`が作るEnterprise Applicationはユーザー割り当て必須です。同意とは別に、ログインさせたい利用者を「エンタープライズ アプリケーション」→対象アプリ→「ユーザーとグループ」で割り当ててください。両方が揃って初めて一般ユーザーがログインできます。

### 3. クライアントシークレットをSecrets Managerへ保存する

Entraが一度だけ返す`$created.ClientSecret`を、例として`cost-control/entra/client-secret`へ保存します。リポジトリ、CDKコンテキスト、CloudFormationパラメータへシークレット本文を書かないでください。AWS Consoleまたは承認済みの秘密登録手順を使用します。

初回登録（シークレットが未作成の場合）:

```powershell
aws secretsmanager create-secret --name "cost-control/entra/client-secret" --secret-string $($created.ClientSecret) --profile default --region us-east-1
```

既に同名のシークレットが存在する場合（再作成や更新時）:

```powershell
aws secretsmanager put-secret-value --secret-id "cost-control/entra/client-secret" --secret-string $($created.ClientSecret) --profile default --region us-east-1
```

`$created.ClientSecret`ではなく`$($created.ClientSecret)`と書く点に注意してください。PowerShellの引数モードでは`$created`だけが展開され、`.ClientSecret`はリテラルとして残ります。

このシークレット登録を先に完了させてから手順4のデプロイを実行してください。デプロイ時、CDKは`SecretValue.secretsManager(clientSecretName)`でこのシークレットをCloudFormation dynamic referenceとして参照するため、未登録のままデプロイするとスタック更新が失敗します。

### 4. Entraオプションでデプロイする

```powershell
npm run deploy -- `
  -c cognitoDomainPrefix=$domainPrefix `
  -c entraEnabled=true `
  -c entraTenantId=$tenantId `
  -c entraClientId=$appClientId `
  -c entraClientSecretName="cost-control/entra/client-secret"
```

`entraTenantId`、`entraClientId`、`entraClientSecretName`のいずれかが欠けるとCDK synthは停止します。標準のCognitoメール/パスワードログインも同時に有効なままです。

ただし`entraEnabled`だけを省略した場合は停止しません。false扱いとなり、`EntraIdentityProvider`がテンプレートから消えて**既存のIdentity Providerが削除されます**。CDKコンテキストは前回値を保存しないため、**2回目以降のデプロイでも毎回この5個をすべて渡してください**。

### ログイン画面に出す認証手段を選ぶ

`loginMethods`コンテキストで、ログイン画面の表示を切り替えられます。

| 値 | ログイン画面の表示 |
|---|---|
| `cognito` | メールアドレスとパスワードの入力欄だけ |
| `entra` | 「Microsoftで続ける」ボタンだけ |
| `cognito-and-entra` | 両方（区切り線付き） |

省略した場合の既定は、`entraEnabled=true`なら`cognito-and-entra`、そうでなければ`cognito`です。これまでと同じ表示になります。

Entra SSOだけを見せる場合は次のようにします。

```powershell
npm run deploy -- `
  -c cognitoDomainPrefix=$domainPrefix `
  -c entraEnabled=true `
  -c entraTenantId=$tenantId `
  -c entraClientId=$appClientId `
  -c entraClientSecretName="cost-control/entra/client-secret" `
  -c loginMethods=entra
```

`entraEnabled=true`なしで`entra`や`cognito-and-entra`を指定すると、ログイン手段のない画面になるためsynthが停止します。未知の値も同様に停止します。

`loginMethods`は画面表示だけでなく、Cognito App Clientの`authFlows`と`supportedIdentityProviders`にも反映します。`entra`ではCognitoのSRPログインを許可せず、`cognito`ではEntra ProviderをApp Clientから外します。UIを迂回した認証も同じ設定で制限します。

デプロイ後、Identity Providerが実際に作られたかを確認します。コンテキストが渡らなかった場合、スタック更新は成功したまま何も作られないため、この確認は省略しないでください。

```powershell
aws cognito-idp list-identity-providers --user-pool-id <UserPoolId> --max-results 10 --profile default --region us-east-1
```

`Providers`に`ProviderName: MicrosoftEntraID`、`ProviderType: OIDC`が現れれば成功です。空配列`[]`の場合は設定が届いていません。`scripts/deploy-config.psd1`を確認してください。

## プレースホルダの確認方法

READMEに登場する`<...>`と`$created.*`の入手方法をまとめる。AWS側の値は`--profile default --region us-east-1`を前提とする。

| プレースホルダ | 意味 | 確認元 |
|---|---|---|
| `<unique-domain-prefix>` | Cognitoドメインのプレフィックス | 自分で決める。省略時は`cost-control-<AWS account ID>` |
| `<deployed-domain-prefix>` | デプロイ済みのプレフィックス | スタック出力`CognitoDomain`の先頭ラベル |
| `<UserPoolId>` / `<UserPoolClientId>` | Cognito User PoolとApp ClientのID | スタック出力 |
| `user@example.com` | 作成する初期ユーザーのメールアドレス | 自分で決める |
| `<Entra tenant GUID>` | EntraテナントID | Entra管理センターまたはCLI |
| `$created.ApplicationClientId` | Entraアプリのクライアント ID | 手順1のスクリプトの戻り値 |
| `$created.ClientSecret` | Entraアプリのクライアントシークレット | 手順1のスクリプトの戻り値（一度きり） |
| `cost-control/entra/client-secret` | Secrets Managerのシークレット名 | 自分で決める |

### AWS側の値をまとめて確認する

デプロイ後はスタック出力にすべて揃っています。

```powershell
aws cloudformation describe-stacks --stack-name WorkmateCostControlStack --profile default --region us-east-1 --query "Stacks[0].Outputs" --output table
```

個別に取り出す場合は`OutputKey`を指定します。

```powershell
aws cloudformation describe-stacks --stack-name WorkmateCostControlStack --profile default --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue | [0]" --output text
```

`<deployed-domain-prefix>`は`CognitoDomain`（`<prefix>.auth.us-east-1.amazoncognito.com`）の先頭ラベルです。

### `<unique-domain-prefix>`を決める

Cognitoのドメインプレフィックスはリージョン内でグローバルに一意である必要があります。既定値に使うAWSアカウントIDは次で確認します。

```powershell
aws sts get-caller-identity --query Account --output text --profile default
```

指定したい値が空いているかは次で確認します。エラーにならず`DomainDescription`が空オブジェクトなら未使用です。他User Poolが使用中の場合はUser Pool IDを含む内容が返ります。

```powershell
aws cognito-idp describe-user-pool-domain --domain <unique-domain-prefix> --profile default --region us-east-1
```

### `<Entra tenant GUID>`を確認する

Microsoft Entra管理センター（<https://entra.microsoft.com>）の「概要」に表示されるテナントIDです。

コマンドで確認する場合、**追加インストールが不要なのは次の方法だけ**です。テナントの検証済みドメイン（`contoso.onmicrosoft.com`や独自ドメイン）からOpenID Connectのディスカバリ文書を引き、`issuer`に含まれるGUIDを取り出します。認証も不要です。

```powershell
$doc = Invoke-RestMethod "https://login.microsoftonline.com/<検証済みドメイン>/v2.0/.well-known/openid-configuration"
[regex]::Match($doc.issuer, '[0-9a-fA-F-]{36}').Value
```

Microsoft Graph PowerShell（`Microsoft.Graph.Authentication`モジュール）が入っている場合は、接続後のコンテキストからも読めます。

```powershell
Connect-MgGraph -Scopes 'Application.Read.All' -NoWelcome
Get-MgContext | Select-Object TenantId, Account
```

`(Get-MgContext).TenantId`が何も表示しない場合、`Get-MgContext`が`$null`を返しています。つまり有効なセッションがありません。まず次で切り分けます。

```powershell
$null -eq (Get-MgContext)
```

`True`なら未接続です。`Connect-MgGraph`のサインインが完了していないか、`-ContextScope Process`で接続したセッションとは**別のPowerShellプロセス**で実行しています。`Process`スコープのコンテキストはそのウィンドウ限りで、閉じると失われます。

Azure CLIが入っている環境では次でも取得できますが、`az`は既定ではインストールされていません。使えない場合は上の方法を使ってください。

```powershell
az account show --query tenantId --output tsv
```

### `$created`の値を後から確認する

`$created`は手順1の`New-EntraCognitoOidcApplication.ps1`が返すオブジェクトです。同じPowerShellセッションを閉じると失われます。

`ApplicationClientId`はEntra管理センターの「アプリの登録」→対象アプリ→「アプリケーション (クライアント) ID」で確認できます。

コマンドで引く場合は、Microsoft Graphへ接続したうえで表示名から検索します。

```powershell
Connect-MgGraph -TenantId "<Entra tenant GUID>" -Scopes 'Application.Read.All' -ContextScope Process -NoWelcome

$filter = [Uri]::EscapeDataString("displayName eq '<アプリの表示名>'")
(Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/applications?`$filter=$filter&`$select=appId,displayName").value
```

Azure CLIが入っていれば次でも取得できます。`az`は既定ではインストールされていません。

```powershell
az ad app list --display-name "<アプリの表示名>" --query "[].appId" --output tsv
```

クライアントIDが分かっていれば、同梱スクリプトで登録内容全体を確認できます。

```powershell
& ".\scripts\entra\Get-EntraCognitoOidcApplication.ps1" `
  -TenantId "<Entra tenant GUID>" `
  -ApplicationClientId "<application client ID>"
```

`ClientSecret`はEntraが作成時に一度だけ返す値で、**後から参照できません**。紛失した場合は再発行します。発行後は手順3でSecrets Managerを更新し、再デプロイします。

```powershell
$rotated = & ".\scripts\entra\New-EntraCognitoOidcClientSecret.ps1" `
  -TenantId "<Entra tenant GUID>" `
  -ApplicationClientId "<application client ID>"
```

### Secrets Managerのシークレット名を確認する

```powershell
aws secretsmanager list-secrets --query "SecretList[].Name" --output table --profile default --region us-east-1
```

登録済みかどうかだけを確かめる場合は次を使います。シークレット本文は表示されません。

```powershell
aws secretsmanager describe-secret --secret-id "cost-control/entra/client-secret" --query Name --output text --profile default --region us-east-1
```

## 削除

このサンプルのS3、User Pool、Runtime、AgentCore Gateway、ツールLambda、AgentCore Memory、Memory暗号化用KMSキーは`DESTROY`方針です。チャット履歴と個人の長期記憶を含め、必要なデータがないことを確認してから実行します。

```powershell
npm run destroy -- -c cognitoDomainPrefix=<deployed-domain-prefix>
```

`<deployed-domain-prefix>`はデプロイ時に指定した値です。分からなくなった場合はスタック出力`CognitoDomain`の先頭ラベルから復元できます（[プレースホルダの確認方法](#プレースホルダの確認方法)を参照）。

EntraアプリとSecrets Manager secretはこのCDKスタック外です。Entraオプションを使った場合は、`scripts/entra`の運用スクリプトと組織の秘密管理手順で別途削除・ローテーションします。
