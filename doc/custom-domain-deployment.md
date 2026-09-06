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

## JSON設定へ5項目を記録する

Git管理外の`scripts/deploy-config.json`を編集する。証明書本文や秘密値は記載しない。

```json
{
  "customDomainEnabled": true,
  "customDomainName": "agent.example.com",
  "hostedZoneId": "<HOSTED_ZONE_ID>",
  "hostedZoneName": "example.com",
  "certificateArn": "arn:aws:acm:us-east-1:<AWS_ACCOUNT_ID>:certificate/<CERTIFICATE_ID>"
}
```

`customDomainName`は`hostedZoneName`直下のサブドメインにする。`certificateArn`はリージョンが`us-east-1`のARNだけを使用する。設定不足、Hosted Zone外の名前、形式不正なARNはCDK実行前またはsynth時に拒否される。

## 通常のデプロイスクリプトで反映する

```powershell
npm run deploy:diff
npm run deploy
```

デプロイにより、CloudFrontへカスタムドメインと証明書が設定され、Route 53にAlias Aレコードが作成される。Cognito App Clientのcallback URLとlogout URLもカスタムドメインへ更新される。CognitoとEntra IDのOIDCリダイレクトURIはCognito提供ドメインを使うため変更しない。

## DNS・HTTPS・スタック出力を確認する

```powershell
aws cloudformation describe-stacks `
  --stack-name AgentCoreCostControlStack `
  --region <AWS_REGION> `
  --profile default `
  --query "Stacks[0].Outputs[?OutputKey=='ApplicationUrl' || OutputKey=='CloudFrontDomainName']"

Resolve-DnsName agent.example.com
Invoke-WebRequest https://agent.example.com/ -Method Head
```

ブラウザでカスタムURLを開き、configの`loginMethods`で有効にしたログイン方式が元のカスタムURLへ戻ることを確認する。Entra IDを有効にした環境では、CognitoログインとEntra IDログインをそれぞれ確認する。

## CloudFront標準URLへ戻す

障害時は設定を無効にして同じスクリプトを再実行する。

```json
{
  "customDomainEnabled": false
}
```

```powershell
npm run deploy:diff
npm run deploy
```

CDKはAlias AレコードとCloudFrontのカスタムドメイン設定を外す。Hosted ZoneとACM証明書はスタック管理外のため削除しない。切り戻し後のURLはCloudFormation出力`ApplicationUrl`で確認する。
