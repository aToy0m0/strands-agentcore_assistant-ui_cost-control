# コスト制限設計

この資料は、対応するAmazon Bedrockモデルの呼び出し前に適用する費用・トークン上限の設計、制御範囲、DynamoDB台帳、障害時動作を説明します。

## 制御するもの

Runtimeは次の3条件を各LLM呼び出し前に同じDynamoDBトランザクションで確認し、事前に算出できる最大使用量を予約します。1つでも上限を超える場合はモデルを呼び出しません。

| 単位 | 上限 | 期間 |
|---|---|---|
| デプロイ先AWSアカウントID | `AccountMonthlyBudgetUsd` | UTC月次 |
| このRuntimeのプロジェクトID | `ProjectMonthlyBudgetUsd` | UTC月次 |
| Cognitoユーザー | 割り当てたプロファイルの`tokenLimit` | UTC日次、月曜開始のUTC週次、またはUTC月次 |

アカウントとプロジェクトの金額は整数nano USD、ユーザー使用量は整数トークンで保持します。現在のDynamoDBテーブルはスタックごとに作成されるため、アカウント上限はこの台帳を共有するRuntime内でのみ集計されます。AWSアカウント全体の全サービス・全スタックを横断する上限ではありません。

## 呼び出し前の予約

```text
認証済みリクエスト
  -> Cognito subとworkmate-limit-<profileID>を検証
  -> モデル、Reasoning、DynamoDB価格マスタの適用条件と確認期限を検証
  -> 全モデルで最大出力を予約
  -> ACCOUNT / PROJECT / USER / REQUESTをDynamoDBで原子的に予約
  -> 予約成功時だけBedrock ConverseStreamを開始
```

Claudeを含む全8モデルは最大出力トークン分だけを呼び出し前に予約し、入力分を応答usageから精算時に追加します。そのため、受け付けた1回の呼び出しで金額またはユーザートークン上限を超える可能性があります。超過実績は台帳へ記録され、後続の呼び出しは停止します。同時実行されたソフト制限リクエストがある場合は、それぞれの未計数入力分が加算されます。

モデルごとの実行時料金は専用のDynamoDB価格マスタだけを正本とし、入力・出力それぞれの100万トークン単価から切り上げ計算します。Runtimeは各呼び出し前に`ConsistentRead=true`で読み、未登録、`ACTIVE`以外、USD以外、リージョン・推論経路・標準サービス階層の不一致、検証期間外をすべて拒否します。期限後に新しい料金を推測するフォールバックはありません。

予約レコードには価格マスタの`version`、入力・出力単価、`verifiedAt`、`verifiedUntil`と`pricingHistoryKey`を複写します。実行途中でマスタが更新されても、精算は予約時に固定した同じ単価を使います。`pricingHistoryKey`から照合時の不変スナップショットを特定できます。DynamoDB TTLは削除時刻が保証されないため停止判定には使わず、Runtimeが日時を直接比較します。

初期レコードはCDKがテーブル新規作成時だけ条件付き投入します。再デプロイで運用中の値を上書きしません。`sources`、Price Listの照合条件、ClaudeのMarketplace `productId`を監査情報として保持し、Runtimeが外部ページから価格を補完することはありません。

EventBridgeは毎日JST 00:00（UTC 15:00）に価格照合Lambdaを起動します。Lambdaは`AmazonBedrock`または`AmazonBedrockFoundationModels`をAWS Price List Query APIの`GetProducts`で検索し、マスタに固定した商品属性と入力・出力usage typeへ完全一致する現行On-Demandディメンションを1件ずつ要求します。`1K tokens`と`1M tokens`を整数nano USD/100万トークンへ正規化して比較します。

- 両単価が一致: `verifiedAt`と`verifiedUntil`を更新し、48時間有効にする
- 単価が不一致: `PRICE_MISMATCH`へ変更し、観測値を記録して即時停止する
- SKUの欠落・重複、未知の単位: `SOURCE_INVALID`へ変更して即時停止する
- Price List APIの一時障害: 期限を延長せず`SOURCE_ERROR`を記録する。次回までに復旧しなければ既存期限で停止する

照合処理はマスタ単価を自動更新せず、停止したモデルも自動的に再有効化しません。価格変更を無審査で受け入れてコスト上限の意味を変えないためです。確認期限を人が延長する運用コマンドはありません。

照合結果はマスタ更新と同じDynamoDBトランザクションで履歴テーブルへ保存します。照合時刻から180日後のTTLを設定し、マスタ値、観測値、SKU、結果を保持します。APIの役割と初期対応付けの方針は[モデル価格調査APIと自動照合方針](pricing-api-strategy.md)を参照してください。

## 完了後の精算

Bedrockの`usage`から実際の入力・出力トークン数と費用を計算します。予約との差額が正なら未計数だった入力分としてカウンターへ加算し、負なら未使用の最大出力分を返却して、リクエストを`SETTLED`へ更新します。

同じトランザクションに全カウンターを含めるため、事前予約部分は並行リクエストでも個別上限を越えて予約できません。予約と精算はrequest IDにより冪等性を確認します。

## DynamoDB台帳

| PK | SK | 内容 |
|---|---|---|
| `MONTH#<YYYY-MM>` | `ACCOUNT#<account ID>` | 月額上限、予約中、確定使用額 |
| `MONTH#<YYYY-MM>` | `PROJECT#<project ID>` | 月額上限、予約中、確定使用額 |
| `USER_WINDOW#<window>#<period>` | `USER#<Cognito sub>` | プロファイル、トークン上限、予約中、確定使用量 |
| `REQUEST#<UUID>` | `RESERVATION` | モデル、価格履歴キー・価格版・固定単価、最大予約値、実績値、状態 |

`committed`は確定使用量と未精算予約の合計、`reserved`は未精算予約、`spent`は精算済み実績です。

## ユーザー上限の割り当て

Cognitoアクセストークンの`cognito:groups`から`workmate-limit-<profileID>`を1つだけ読み取ります。該当グループがなければ既定プロファイルを使います。複数所属、未知のプロファイル、削除済みプロファイルは安全側で拒否します。

グループ変更は発行済みアクセストークンへ反映されないため、変更後は再ログインが必要です。同じ期間内にプロファイルIDまたは上限値を変更して既存台帳と一致しなくなった場合も、値を上書きせず実行を拒否します。

## 障害時の動作

- 料金検証またはDynamoDB予約に失敗した場合、Bedrockモデルは呼び出しません。
- 価格マスタの確認期限が切れた場合、そのモデルだけをBedrock呼び出し前に停止します。
- 日次照合で単価差または公式データの曖昧性を検出した場合、そのモデルを即時停止します。
- Bedrock送信後に`usage`を取得できない場合、課金済みの可能性があるため予約を自動解放しません。
- 精算失敗や残留予約を自動照合するジョブは未実装です。運用者がDynamoDBとBedrock利用記録を照合する必要があります。
- プロンプトキャッシュ利用量が返された場合は、キャッシュ料金を計算できないため精算を拒否し、予約を保持します。

## 制御対象外

この仕組みは対応モデルのオンデマンド入力・出力トークン料金だけを制御します。ソフト制限モデルの入力分は事後加算であり、絶対的なhard limitではありません。税、割引、為替、無料枠、およびAgentCore Runtime、Memory、Gateway、Knowledge Base、Lambda、DynamoDB、KMS、CloudFront、CloudWatch Logsなどの料金は含みません。AWS全体の予算通知や異常検知にはAWS Budgets、Cost Anomaly Detectionなどを別途使用します。

利用額表示、管理API、残留予約の解除・照合、複数スタックで共有するアカウント台帳は現在の対象外です。

## 主な実装

| ファイル | 責務 |
|---|---|
| `shared/model-catalog.ts` | 対応モデル、推論経路、計数経路 |
| `shared/initial-model-pricing.ts` | 価格マスタの初期値と監査元 |
| `shared/user-limit-profiles.ts` | ユーザープロファイルとUTC期間 |
| `runtime/src/pricing-catalog.ts` | 価格マスタの強整合読み取りとfail-closed検証 |
| `pricing-verifier/index.py` | AWS Price List APIとの日次照合、期限延長、差異時停止 |
| `runtime/src/token-counter.ts` | トークン計数 |
| `runtime/src/model-factory.ts` | 最大値の算出、予約、モデル実行、実績精算 |
| `runtime/src/budget-ledger.ts` | DynamoDBトランザクションと台帳形式 |
| `infrastructure/stack.ts` | 台帳、照合Lambda・日次Schedule、Runtime環境変数、最小権限IAM |
