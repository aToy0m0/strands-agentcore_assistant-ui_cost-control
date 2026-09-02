# カスタムドメインのデプロイ手順

CloudFrontの標準URLから、Route 53で管理するサブドメインへ切り替える手順を示す。CDKは既存Hosted Zoneと既存ACM証明書を参照し、CloudFrontのAlternate Domain NameとAlias Aレコードを管理する。

## 事前にHosted Zoneと証明書を用意する

- 対象ドメインのPublic Hosted ZoneがRoute 53に存在すること
- CloudFront用ACM証明書が`us-east-1`にあり、状態が`ISSUED`であること
- 証明書のSANが設定するホスト名を対象に含むこと
- 同じホスト名を別のCloudFront Distributionが使用していないこと

ワイルドカード`*.example.com`が対象にするのは`app.example.com`のような1階層だけである。`app.dev.example.com`には別のSANが必要となる。

```powershell
aws route53 get-hosted-zone `
  --id <hosted-zone-id> `
  --profile default

aws acm describe-certificate `
  --certificate-arn <certificate-arn> `
  --region us-east-1 `
  --profile default
```

## デプロイ設定へ5項目を記録する

`scripts/deploy-config.psd1`を編集する。証明書本文や秘密値は記載しない。

```powershell
CustomDomainEnabled = $true
CustomDomainName = "cost-control.example.com"
HostedZoneId = "<route53-hosted-zone-id>"
HostedZoneName = "example.com"
CertificateArn = "arn:aws:acm:us-east-1:<aws-account-id>:certificate/<certificate-id>"
```

`CustomDomainName`は`HostedZoneName`直下のサブドメインにする。`CertificateArn`はリージョンが`us-east-1`のARNだけを使用する。設定不足、Hosted Zone外の名前、形式不正なARNはCDK実行前またはsynth時に拒否される。

## 通常のデプロイスクリプトで反映する

```powershell
Set-Location "<project-directory>"
.\scripts\Deploy-Workmate.ps1
```

デプロイにより、CloudFrontへカスタムドメインと証明書が設定され、Route 53にAlias Aレコードが作成される。Cognito App Clientのcallback URLとlogout URLもカスタムドメインへ更新される。CognitoとEntra IDのOIDCリダイレクトURIはCognito提供ドメインを使うため変更しない。

## DNS・HTTPS・スタック出力を確認する

```powershell
aws cloudformation describe-stacks `
  --stack-name WorkmateCostControlStack `
  --region us-east-1 `
  --profile default `
  --query "Stacks[0].Outputs[?OutputKey=='ApplicationUrl' || OutputKey=='CloudFrontDomainName']"

Resolve-DnsName cost-control.example.com
Invoke-WebRequest https://cost-control.example.com/ -Method Head
```

ブラウザでカスタムURLを開き、CognitoログインとEntra IDログインの両方が元のカスタムURLへ戻ることを確認する。

## CloudFront標準URLへ戻す

障害時は設定を無効にして同じスクリプトを再実行する。

```powershell
CustomDomainEnabled = $false

.\scripts\Deploy-Workmate.ps1
```

CDKはAlias AレコードとCloudFrontのカスタムドメイン設定を外す。Hosted ZoneとACM証明書はスタック管理外のため削除しない。切り戻し後のURLはCloudFormation出力`ApplicationUrl`で確認する。
