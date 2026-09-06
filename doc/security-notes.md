# セキュリティと運用上の境界

## 実装済み

- Cognito User Poolの自己サインアップを無効にし、管理者が利用者を作成する
- `loginMethods`に合わせてCognito App Clientが許可する認証プロバイダーと認証フローを制限する
- Cognito JWT Authorizer検証後の`sub`を監査用actor IDとして使用する
- UI、Runtime入力検証、Bedrock IAMへ同じモデルallowlistを適用する
- Gemini APIキーとEntraクライアントシークレットはSecrets Managerから取得し、configへ本文を書かない
- Knowledge Baseの`bedrock:Retrieve`をconfigで有効なARNへ限定する
- Gatewayターゲットはコード側カタログに登録した実装だけをconfigから有効化する
- S3を非公開にし、Web配信はCloudFront OACだけを許可する
- RuntimeはVersioning付きS3価格表を読み取り、書き換えない
- 価格照合Lambdaは警告だけを出し、価格表や実行可否を変更しない
- 費用実績は`usageEventId`で冪等に加算する
- usage不明時は金額を推定せず`USAGE_UNAVAILABLE`として記録する
- CloudWatch Logsの保持日数を環境configで指定する

`runtime-config.json`に含まれるUser Pool ID、App Client ID、Cognitoドメイン、Runtime ARNは、SPAが接続に使う公開識別子でありシークレットではない。Gemini APIキーとEntraクライアントシークレット本文は含めない。

## ソフト上限の限界

月額上限はAWS請求を止めるハードリミットではない。モデル以外のAgentCore、Memory、KMS、CloudFront、Logsなどは対象外であり、AWS BudgetsやCost Anomaly Detectionを別途使用する。

予約を持たないため、同時に開始したモデル呼び出しの実費分だけ上限を超える可能性がある。運用を単純にする設計上のトレードオフである。より厳密な同時実行制御が必要になった場合に限り、予約方式を再検討する。

## ログ

`runtimeLogRequest`、`runtimeLogModel`、`runtimeLogTool`は本文を含み得る。本番では必要な種類だけを有効にする。費用ログは単価、価格表版、S3 Version ID、トークン数を含むが、プロンプト本文を必要としない。

開発環境は短期保持、本番は180日など、`logRetentionDays`を監査要件に合わせる。より長期または改ざん耐性が必要なら、別途監査用S3集約を設計する。

## 未実装または別途必要な統制

| 項目 | 現状と影響 |
|---|---|
| WAF・短時間レート制限 | 未実装。月額上限内での連続呼び出しによる可用性低下は防げない |
| Bedrock Guardrails | 未実装。禁止トピック、PII、プロンプト攻撃を専用機能で遮断しない |
| セキュリティレスポンスヘッダー | CSP、HSTS、`frame-ancestors`などを専用ポリシーで設定していない |
| CloudFrontアクセスログ | 未設定。Web配信経路の追跡はCloudFront標準メトリクスだけでは不足する |
| CloudWatch LogsのKMS暗号化・Data Protection | 専用設定なし。本文ログの無効化、保持期間、IAMによる閲覧制限が中心となる |
| httpOnly Cookie | BFFを持たないため未対応。Amplifyのブラウザ側トークンはXSS発生時に露出し得る |
| モデル以外のAWS費用上限 | 対象外。AWS BudgetsやCost Anomaly Detectionを別途設定する |
| 管理者画面 | 未実装。Cognito利用者、Entra割り当て、シークレットは管理手順とCLIで扱う |

## 実環境で確認する項目

- 有効モデルごとの呼び出しとCountTokens経路
- Geminiシークレットへの最小権限アクセス
- 複数Knowledge BaseとGatewayターゲットの呼び分け
- 月額上限到達と、`NO_CHARGE`・`USAGE_UNAVAILABLE`の分類
- 価格不一致警告とCloudWatch Alarm
- 独自ドメイン利用時の`us-east-1` ACM証明書
- スマートフォンでの表示、横スワイプによるメニュー操作、入力時の拡大抑止
