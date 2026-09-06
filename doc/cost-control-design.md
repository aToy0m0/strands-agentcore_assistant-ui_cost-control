# コスト制御設計

## 目的

アプリ全体の月額LLM費用を、モデルプロバイダーをまたいで単純に制御する。AWS請求のハード上限ではなく、呼び出し前判定によるソフト上限である。

## 集計キー

- 設定: `PK=APP#<費用集計ID>, SK=CONFIG`
- 月次実績: `PK=APP#<費用集計ID>, SK=MONTH#YYYY-MM`
- 利用イベント: `PK=APP#<費用集計ID>, SK=USAGE#<usageEventId>`

費用集計IDは正規化済み`defaultCdkPrefix`からCDKが生成し、Runtime物理IDから独立させる。個別のconfig項目は持たず、アカウント、プロジェクト、ユーザー上限の二重管理も行わない。

## 呼び出しフロー

1. プロバイダー標準CountTokensを優先し、失敗時はStrands SDKの推定値を使って警告する。
2. S3価格表から入力単価を読み、入力見積り費用を計算する。
3. 強い整合性で設定と当月実績を読み、実績と入力見積りの合計が上限以内か確認する。
4. モデルを呼び出す。最大出力費用は予約しない。
5. 応答usage、使用単価、価格表Version IDから実費を計算する。
6. `usageEventId`の条件付きPutと月次実績加算をDynamoDB transactionで行う。

事前判定とモデル完了までに並行呼び出しがあるため、厳密なハードキャップではない。予約を廃止する代わりに、理解容易性と通常運用の単純さを優先する。

## 事前トークン数はプロバイダー標準APIを優先する

| プロバイダー | 優先する計数方法 | 利用できない場合 |
|---|---|---|
| Amazon Bedrock | Bedrock Runtime `CountTokens` | Strands SDKの概算へ切り替え、警告ログを出す |
| Google Gemini | Google `countTokens` | Strands SDKの概算へ切り替え、警告ログを出す |

自作トークナイザーは持たない。概算へ切り替えた場合は`model.token_count.recorded`の計数元から判別できる。計数そのものが成立しない場合はモデルを呼び出さず、原因をエラーとして返す。

GPT-5.6 Lunaのようにコンテキスト長で単価が変わるモデルは、事前計数結果から該当する価格段階を選ぶ。価格段階の上限は費用ログへ保存し、後から適用根拠を確認できるようにする。

## 価格表を実行時の正本にする

モデル価格表はコードレビュー後にCDKアセットとしてVersioning付きS3へ配置する。Runtimeは呼び出しごとに価格表を読み、次を検証する。

- `schemaVersion`と通貨
- モデルIDの登録有無
- リージョン、推論経路、サービス階層
- 入力・出力単価
- コンテキスト段階価格

リージョンなどの条件不一致と確認期限超過は警告するが、それだけでモデルを停止しない。価格表を取得できない、JSONが壊れている、モデルや単価がない場合は費用計算が成立しないため、モデル呼び出し前に停止する。

実費ログには価格カタログ版、S3 Version ID、入力・出力単価、トークン数、nano USD費用を保存する。別の価格履歴DynamoDBテーブルは持たない。

## DynamoDB台帳

| PK | SK | 内容 |
|---|---|---|
| `APP#<費用集計ID>` | `CONFIG` | `limitNanoUsd`を含むアプリ設定 |
| `APP#<費用集計ID>` | `MONTH#<YYYY-MM>` | `spentNanoUsd`と更新時刻 |
| `APP#<費用集計ID>` | `USAGE#<usageEventId>` | モデル、状態、トークン数、費用、発生日時 |

費用が確定した呼び出しは、利用イベントの条件付きPutと月次実績の加算を1つのDynamoDB transactionで実行する。同じ`usageEventId`が同内容で再送された場合は成功扱いとし、内容が異なる場合は二重計上を避けるためエラーにする。

## 障害

推論開始前に拒否された呼び出しは`NO_CHARGE`、ストリーム開始後にusageを取得できなかった呼び出しは`USAGE_UNAVAILABLE`として金額なしで記録する。どちらも月次実績へ加算せず、後続呼び出しを止めない。推定額、タイマー、解除処理は持たない。

同じ`usageEventId`の再試行は同内容なら成功扱い、内容が異なる場合はエラーにする。これにより二重加算を防ぐ。

価格照合の不一致、公式価格の取得失敗、確認期限超過はCloudWatchの警告対象である。照合処理はS3価格表を書き換えず、Runtimeの呼び出し可否も変更しない。運用者が根拠を確認し、必要な価格修正をコードレビューと再デプロイで反映する。

## 制御対象外

対象は価格表へ登録したモデルの入力・出力トークン費用である。次は月額上限へ含めない。

- 税、割引、為替、無料枠
- AgentCore Runtime、Memory、Gateway
- Bedrock Knowledge Base
- Lambda、DynamoDB、S3、KMS
- CloudFront、CloudWatch Logs

AWS請求全体の通知と異常検知には、AWS BudgetsやCost Anomaly Detectionを併用する。短時間の連続呼び出しを制限するWAFやレート制限も別の統制となる。

## 保持

利用イベントには180日のTTLを設定する。CloudWatch Logsの保持日数は`logRetentionDays`で環境別に指定する。月次集計はTTL対象外である。

## 主な実装

| ファイル | 責務 |
|---|---|
| `shared/model-catalog.ts` | 対応モデル、推論経路、Reasoning制約 |
| `shared/initial-model-pricing.ts` | S3へ配置する価格表の初期値と根拠 |
| `runtime/src/token-count-logging.ts` | 標準APIとSDK概算の選択、警告ログ |
| `runtime/src/pricing-catalog.ts` | S3価格表の取得、検証、価格段階の選択 |
| `runtime/src/model-factory.ts` | 事前判定、モデル呼び出し、usage記録 |
| `runtime/src/budget-ledger.ts` | 月次実績と利用イベントの冪等な記録 |
| `pricing-verifier/index.py` | AWS Price List APIとの照合と警告 |
| `infrastructure/stack.ts` | 台帳、価格表、照合Lambda、Dashboard、IAM |
