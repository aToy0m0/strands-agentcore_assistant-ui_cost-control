# モデル価格調査APIと自動照合方針

## 採用方針

自動照合の正本はAWS Price List Query APIの`GetProducts`です。「List系APIへ統一」ではなく、Price List Query APIへ統一し、実価格ディメンションを返す`GetProducts`を使う方針へ変更しました。

Claudeは`ServiceCode=AmazonBedrockFoundationModels`、Nova・GPT-OSS・GLMは`ServiceCode=AmazonBedrock`を検索します。サービスコードは異なりますが、呼び出すAPI、完全一致判定、単価の正規化、停止規則は同じです。

## APIの役割

| API | 得られるもの | このシステムでの用途 |
|---|---|---|
| Bedrock `ListFoundationModels` / `GetFoundationModel` | モデルID、入出力モダリティ、推論方式、ライフサイクル | 対応モデルの発見と提供状況の確認。単価取得には使わない |
| Price List Query `DescribeServices` / `GetAttributeValues` | サービスと商品属性の候補 | 新モデル調査時のスキーマ確認 |
| Price List Query `GetProducts` | SKU、On-Demand価格ディメンション、単位、発効日 | 日次の自動照合に採用 |
| Price List Bulk `ListPriceLists` / `GetPriceListFileUrl` | 地域・通貨別の価格表ファイル | 大量商品を一括監査する場合の補助。8モデルの日次処理には使わない |
| Marketplace Discovery `GetProduct` / `ListPurchaseOptions` / `GetOffer` / `GetOfferTerms` | Marketplaceの商品、購入オプション、オファー、契約条件 | 監査調査のみ。Runtimeの単価決定には使わない |
| Cost Explorer `GetCostAndUsage` | 集計済みの実請求額 | 事後の請求照合。現在単価や1呼び出しの価格版には使わない |
| Bedrock応答の`usage` | 呼び出し単位の入力・出力トークン数 | 予約時に固定した単価との積で実績額を精算 |

Marketplace DiscoveryにはBedrockの`modelId`からMarketplaceの`productId`へ変換する公式APIがありません。このため、以前検討した変換マスタを自動価格取得の中核にはしていません。Claudeの既知の`productId`は初期マスタに監査メタデータとして残しますが、照合はPrice Listの商品属性とusage typeで行います。

## 初期マスタ

`shared/initial-model-pricing.ts`のモデルID、Price List検索条件、開始単価はコードレビュー可能な初期シードとして手動で登録しています。ただし、開始単価はWebページから転記した値ではなく、公式Price List Query APIの実レスポンスから算出した値です。

初期シードは空のテーブルにだけ投入され、再デプロイで運用値を上書きしません。新モデル追加時にはモデルIDとPrice List商品を結ぶ検索条件のレビューが一度必要です。その後の価格照合は自動です。公式API内にモデルIDとの結合キーがないため、この最初の対応付けまで完全自動化すると誤商品を採用する危険があります。

## 日次照合と停止

EventBridgeは毎日JST 00:00（UTC 15:00）に照合Lambdaを起動します。デプロイ時にもRuntime作成前に同じLambdaを一度実行します。

照合はマスタに固定した商品属性と入力・出力usage typeについて、現行On-Demand価格ディメンションがそれぞれ正確に1件であることを要求します。単価一致時だけ確認期限を48時間後へ延長します。単価差、欠落、重複、未知の単位はモデルを即時停止し、API一時障害では期限を延長しません。観測価格を無審査でマスタへ自動反映することはありません。

## 180日履歴と呼び出し追跡

価格照合のたびに`ModelPricingHistory`へ不変スナップショットを保存します。

| 属性 | 内容 |
|---|---|
| `modelId` | パーティションキー |
| `verificationId` | `<verifiedAt>#<version>`のソートキー |
| `status` | `MATCH`、`PRICE_MISMATCH`、`SOURCE_INVALID`、`SOURCE_ERROR` |
| マスタ単価・照合条件 | その時点で判断に使った値 |
| 観測単価・SKU・公開日 | 公式APIから取得できた値 |
| `expiresAt` | 照合時刻から180日後のDynamoDB TTL |

各`REQUEST#<request ID>/RESERVATION`には`modelId`、`pricingHistoryKey`、価格版、確認日時、入力・出力単価を保存します。これにより、後からその呼び出しがどの価格スナップショットと単価で予約・精算されたかを特定できます。DynamoDB TTLの削除は非同期なので、履歴は180日を過ぎてしばらく残る場合があります。

```powershell
# モデルの照合履歴を新しい順に表示
node .\scripts\manage-model-pricing.mjs history --model-id=us.anthropic.claude-sonnet-5 --profile=default

# request IDから予約レコードと使用した価格履歴をまとめて表示
node .\scripts\manage-model-pricing.mjs request --request-id=<request-id> --profile=default
```
