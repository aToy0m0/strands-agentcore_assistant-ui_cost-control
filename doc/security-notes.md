# セキュリティ上の注意と既知の制約

最終更新日: 2026-08-30

本リポジトリは研究・学習用途のサンプルです。詳細な脅威モデルは[SECURITY.md](../SECURITY.md)を参照してください。

## 実装済みの境界

- AgentCore RuntimeとGatewayはCognito JWT Authorizerで保護する
- User Poolの自己登録を無効にし、App Clientのログイン方式も設定値に合わせて制限する
- JWT Authorizer検証後のアクセストークン`sub`をユーザーIDとして固定する
- Bedrock推論対象を、厳密な事前トークン計数と料金表を持つモデルだけに限定する
- アカウント・プロジェクトの月額費用上限をDynamoDBトランザクションで事前予約する
- Cognitoグループ別に、日次・週次・月次のユーザートークン上限を同じトランザクションで予約する
- 未知モデル、CountTokens失敗、未知プロファイル、複数プロファイル割り当てではLLMを呼ばない
- S3を非公開にし、Web配信はCloudFront OACだけを許可する

`runtime-config.json`に含まれるUser Pool ID、App Client ID、Cognitoドメイン、Runtime ARNはpublic App Clientの接続情報であり、秘密情報ではありません。

## 未実装または対象外の防御

| 項目 | 現状 | 影響 |
|---|---|---|
| WAF・短時間レート制限 | 未実装 | 費用・トークン上限内での連投による可用性影響は防げない |
| Bedrock Guardrails | 未実装 | 禁止トピック、PII、プロンプト攻撃を専用機能で遮断しない |
| セキュリティレスポンスヘッダー | CSP、HSTS、frame-ancestors等が未設定 | XSSやクリックジャッキングへの多層防御が不足 |
| CloudFrontアクセスログ | 未設定 | 配信経路の追跡性が不足 |
| ログのKMS暗号化・Data Protection | 未設定 | Runtimeログの本文保護は設定による出力停止と短期保持に依存 |
| httpOnly Cookie | BFFを持たないため未対応 | JWTはAmplify既定のブラウザストレージにあり、XSS時に露出し得る |
| LLM以外のAWS費用hard limit | 対象外 | Runtime、Memory、KMS、CloudFront、Logs等はAWS Budgets等で別途監視が必要 |
| 予約障害の照合ジョブ | 未実装 | Bedrock送信後にusageを取得できない場合、予約を安全側で保持し続ける |

## ユーザー上限の安全側動作

- グループ未所属だけは既定プロファイルを適用する
- `workmate-limit-*`へ複数所属している場合は認証エラーにする
- 削除済み・未知のプロファイルIDは既定へフォールバックしない
- プロファイル変更は既存アクセストークンへ反映されないため再ログインが必要
- 同一ウィンドウ中に同じプロファイルIDの上限値を変更すると、既存台帳との不一致により安全側で停止する

## 検証範囲

型検査、lint、Webビルド、Runtime CodeZip生成、単体テスト、CDK assertion、CDK synthをローカルで確認しています。実設定から3つのCognitoグループとRuntime環境変数が合成されることも確認済みです。

次は未確認です。

- 本サンプルスタックのAWSデプロイ
- 実際のCognitoアクセストークンを使ったグループ割り当てE2E
- 実Bedrockでの日次・週次・月次上限到達試験
- 利用者が設定した独自ドメインと証明書によるHTTPS疎通
- 障害時の予約照合・運用復旧
