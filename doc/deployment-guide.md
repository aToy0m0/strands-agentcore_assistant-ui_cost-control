# デプロイ手順

## 前提

- Node.js 24
- AWS CLIとCDK
- デプロイ権限を持つAWS CLIプロファイル`cdkdep`
- 参照用`default`、CognitoユーザーなどCDK管理外の変更用`admin`プロファイル
- Geminiを使う場合はAPIキーをSecrets Managerへ登録済み
- 独自ドメインを使う場合はRoute 53 Hosted Zoneと`us-east-1`のACM証明書を作成済み

第三者モデルを有効化する前に、[Bedrockモデル利用契約の事前準備](./model-access-prerequisites.md)に従ってアカウント側の契約と利用可否を確認する。この操作はCDK管理外とする。

## config作成

```powershell
Copy-Item .\scripts\deploy-config.us-east-1.example.json .\scripts\deploy-config.json
```

東京は`deploy-config.ap-northeast-1.example.json`を使う。Knowledge Base ID、カスタムドメイン、Hosted Zone、証明書ARN、Secrets Manager名のサンプル値を実環境へ合わせる。Cognito提供ドメインはCloudFormation Stack IDから自動生成されるため、configでは指定しない。複数Knowledge Baseと複数Gatewayターゲットは配列へ追加する。

## 事前確認

```powershell
npm ci
npm run runtime:install
npm run verify
npm run deploy:test
npm run deploy:diff
```

`deploy:diff`と`deploy`はMJSスクリプトがJSONを検証し、CDKを`cdkdep`で実行する。PowerShell固有のデプロイスクリプトは使用しない。

## 反映

```powershell
npm run deploy
```

CDKはCloudFormation差分だけを更新する。Dockerのマルチステージビルドとは異なり、依存関係を含む単一スタックの変更セットとして適用される。価格表または月額上限だけを変更した場合は、通常は関連するS3アセット、DynamoDB設定用カスタムリソース、必要なRuntime設定だけが更新され、無関係な物理リソースは作り直されない。手動でAWSリソースだけを変更すると次回デプロイでCDK定義へ戻るため、設定はconfigまたはコードで変更する。

## 確認

CloudFormation OutputsからアプリURL、Runtime ARN、費用台帳、価格表Bucket、CloudWatch Dashboard名を確認する。`priceVerificationEnabled=true`なら価格照合Lambda名も出力される。

### Cognito利用者は管理者が作成する

Cognitoの自己サインアップは無効であり、CDKは初期利用者を作成しない。CDK管理外のユーザー作成には一時的な`admin`認証を使用する。

```powershell
aws login --profile admin
npm run cognito:user:create -- --email <利用者メールアドレス> --profile admin --region <AWS_REGION>
aws logout --profile admin
```

スクリプトはStack OutputからUser Pool IDを取得し、24文字のランダムな恒久パスワードを設定する。ログインIDとパスワードは標準出力へ一度だけ表示されるため、安全な保管先へ記録する。既存利用者のパスワード再発行には`npm run cognito:user:set-password`を使う。

1. CognitoまたはEntra IDでログインする。
2. 有効化したBedrockモデルとGeminiで応答を確認する。
3. 各Knowledge BaseとGateway Lambdaツールを呼び分ける。
4. CloudWatch Dashboardで費用とトークン数を確認する。
5. Runtime Logsで`model.cost.recorded`、価格表Version ID、単価を確認する。

## 月途中の設定変更

`monthlyBudgetUsd`または価格表を変更して同じ手順で再デプロイする。月額上限は次回の事前判定から、価格表は次回のモデル呼び出しから使われる。当月実績は年月キーで保持され、月が変わると自然に新しいレコードへ切り替わる。

価格照合の不一致は警告であり、モデル呼び出しを停止しない。価格表修正が必要ならコード側の価格カタログを更新し、レビュー後に再デプロイする。

## ロールバック

コードまたはconfigを戻して再デプロイする。S3価格表はVersioningされるが、Runtimeが参照するのはCDK配置先キーの現行版であるため、ロールバックもCDKで行う。費用台帳の利用イベントと月次実績は運用記録なので、スタック更新のロールバックだけでは書き換えない。
