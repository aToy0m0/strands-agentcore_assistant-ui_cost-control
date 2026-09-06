# モデル価格表と照合方針

## 正本

コード管理したモデル価格カタログをCDKでVersioning付きS3へ配置し、Runtimeの計算用正本とする。configの`modelIds`は安定したモデルキーをデプロイ先リージョンの実呼び出しIDへ対応付け、CDKはその実呼び出しIDをS3価格表のキーに使う。各価格項目にはプロバイダー、通貨、価格の対象リージョン、推論経路、入力・出力単価、確認日、再確認期限、版、根拠URLを含める。

Runtimeは毎回S3から価格表を読み、S3 Version IDを含むスナップショットを作る。モデル応答後の費用ログには、トークン数、実費、価格表版、S3 Version ID、使用単価を直接保存する。別の価格履歴DynamoDBテーブルは持たない。

## APIごとの役割を分ける

| API・情報源 | 得られるもの | 用途 |
|---|---|---|
| Bedrock `ListFoundationModels` / `GetFoundationModelAvailability` | モデルの提供状況とアカウントの利用可否 | デプロイ前のモデル利用確認。単価取得には使わない |
| AWS Price List Query `GetProducts` | SKU、On-Demand価格ディメンション、単位、発効日 | Amazon Bedrockモデルの定期照合 |
| BedrockまたはGoogleの応答`usage` | 呼び出し単位の入力・出力トークン数 | 実費計算 |
| Google公式料金表 | Geminiの公開単価 | 人が価格カタログを更新するときの根拠 |
| Cost Explorer | 集計済みの実請求額 | 事後の請求確認。呼び出し時の単価決定には使わない |

BedrockのモデルIDとPrice List商品を常に一意に結び付ける公式APIはない。AWSモデルはコード側にレビュー済みの商品属性、入力usage type、出力usage typeを保持し、`GetProducts`の候補を完全一致で照合する。

Price Listの単位が`1K tokens`なら100万トークン単価へ1000倍し、`1M tokens`ならそのまま整数nano USDへ変換する。現行On-Demandディメンションが0件または複数件、単位が未知、金額を正の整数nano USDで表せない場合は、価格ソース不正として警告する。

## 定期照合

`priceVerificationEnabled=true`の環境では、EventBridgeが毎日JST 00:00（UTC 15:00）にLambdaを起動して次を行う。

- Amazon BedrockモデルをAWS Price List APIの候補と照合
- 単価不一致、取得失敗、確認期限超過を構造化ログへ記録
- ログメトリクスとCloudWatch Alarmで警告

照合Lambdaは価格表を書き換えず、不一致を理由にRuntimeを停止しない。価格表を自動更新すると誤った候補の選択がそのまま課金判定へ入るため、人のレビューを経たCDK更新を境界とする。

Google GeminiはAWS Price List対象外である。Google公式価格を人が確認してカタログを更新し、確認期限超過は同じ警告経路で検知する。

| 警告状態 | 意味 | 対応 |
|---|---|---|
| `PRICE_MISMATCH` | 登録単価とAWS観測単価が異なる | 商品対応と公式価格を確認し、必要ならコードを更新する |
| `SOURCE_INVALID` | 候補の欠落・重複、未知単位、設定不備 | Price List検索条件を見直す |
| `SOURCE_ERROR` | AWS Price List APIの取得失敗 | 一時障害と権限を確認し、次回照合も監視する |
| `REVIEW_OVERDUE` | `reviewDueAt`を過ぎた | AWSまたはGoogleの根拠を再確認して期限を更新する |

各警告は`pricing.verification.warning`として構造化ログへ出力し、ログメトリクスとCloudWatch Alarmへ接続する。成功・失敗件数は`pricing.verification.completed`へ集約する。

## 価格変更はコードレビューと再デプロイで反映する

価格表の初期値は`shared/initial-model-pricing.ts`で管理する。モデル追加または価格変更では、モデルキー、各リージョンの`modelIds`、価格の対象リージョン、推論経路、サービス階層、根拠、Price List検索条件をレビューする。USと東京でGeo／Global推論プロファイルが異なる場合は、それぞれのconfigサンプルへ別のIDを明示し、Runtimeで暗黙に置換しない。

反映は次の順序で行う。

1. 公式の価格根拠を確認する。
2. `shared/initial-model-pricing.ts`の単価、版、確認日、再確認期限を更新する。
3. 価格照合テストとRuntimeテストを実行する。
4. `npm run deploy:diff`でS3価格表と関連リソースの差分を確認する。
5. `npm run deploy`でVersioning付きS3へ新しい価格表を配置する。

古い価格表はS3 Versioningに残る。呼び出し時に使ったVersion IDと単価は費用ログへ直接保存するため、DynamoDBの価格履歴テーブルを復活させる必要はない。

## 照合と実行時制御を分離する

「価格不一致は停止せず警告」は、価格計算の継続性を優先する方針である。ただし照合自体を削除すると、古い単価を使い続けても検知できない。そこで実行時の正本と監視を分け、Runtimeは登録済み単価で継続し、軽量な定期照合だけをAlarmへ接続する。
