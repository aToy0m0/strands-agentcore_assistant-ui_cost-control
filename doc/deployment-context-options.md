# デプロイ設定一覧

最終更新日: 2026-09-08

デプロイ設定はGit管理外の`scripts/deploy-config.json`へ集約する。CDKのdiffとdeployは`scripts/deploy.mjs`から実行し、AWS CLIプロファイルは`cdkdep`に固定する。

## リージョン別の開始点

- 米国: `scripts/deploy-config.us-east-1.example.json`
- 東京: `scripts/deploy-config.ap-northeast-1.example.json`

東京配置でもCloudFront用ACM証明書だけは`us-east-1`に必要となる。サンプル内の識別子は実環境の値へ置き換える。

## JSON項目

| キー | 用途・制約 |
|---|---|
| `profile` | 必ず`cdkdep` |
| `region` | AWS配置リージョン |
| `defaultCdkPrefix` | AWSリソース名、費用集計ID、Memory名前空間の共通入力。対象サービスの制約に合わせてCDKが正規化 |
| `runtimeDisplayName` | 画面に表示する名前。AWSリソース名の生成には使用しない |
| `webDebugMode` | `on` / `off` |
| `customDomainEnabled` | 独自ドメインの有効化 |
| `customDomainName` | 有効時のFQDN |
| `hostedZoneId` / `hostedZoneName` | 有効時に参照する既存Route 53 Hosted Zone |
| `certificateArn` | 有効時に参照する`us-east-1`のACM証明書ARN |
| `allowCrossRegionKnowledgeBases` | Knowledge Baseのリージョン越境を明示許可するか |
| `knowledgeBases` | 利用可能なKnowledge Baseの配列 |
| `gatewayTargets` | 同一AgentCore Gatewayへ追加するLambdaターゲットの配列 |
| `additionalRuntimes` | UIから切り替えて呼び出す既存AgentCore Runtimeの配列。複数のRuntime IDまたはARNを指定可能。このStackが作るRuntimeは`primary`として自動登録 |
| `geminiEnabled` | Geminiプロバイダーを有効化するか |
| `geminiApiKeySecretName` | Gemini APIキーを保持するSecrets Manager名 |
| `enabledModelKeys` | 配置環境で利用確認済みモデルのallowlist |
| `modelIds` | モデルキーから実呼び出しIDへの対応表。有効モデルのIDは必須。未知キー、重複ID、不正な文字列は拒否 |
| `entraEnabled` | Microsoft Entra ID連携の有効化 |
| `entraTenantId` / `entraClientId` | Entra有効時の公開識別子 |
| `entraClientSecretName` | Entraクライアントシークレットを保持するSecrets Manager名 |
| `loginMethods` | `cognito` / `entra` / `cognito-and-entra` |
| `logRetentionDays` | CloudWatch Logs対応保持日数。例: 開発14日、本番180日 |
| `runtimeLogRequest` / `runtimeLogModel` / `runtimeLogTool` | 各本文ログの`on` / `off` |
| `monthlyBudgetUsd` | アプリ単位のソフト月額上限。0より大きく小数9桁まで |
| `priceVerificationEnabled` | AWS価格の定期照合と警告Alarmを作成するか |
| `costDashboardEnabled` | 費用・トークン用Metric FilterとCloudWatch Dashboardを作成するか。現行サンプルは`false` |

未知のJSONキーは入力誤りとして拒否する。

## モデルID

`enabledModelKeys`と`modelIds`は役割が異なる。前者はUI表示・入力検証・IAM許可の対象を選び、後者はRuntimeが実際に呼び出すIDを決める。CDKは有効モデルに対応するIDがない場合にsynth前で停止し、指定されたIDをRuntime、価格表の参照キー、Bedrock IAMへまとめて反映する。別リージョンのIDへ暗黙には切り替えない。

サンプルには、2026-09-06時点でAWS APIから確認した全対応モデルのIDを記載している。主なリージョン差は次のとおり。

| configキー | `us-east-1` | `ap-northeast-1` |
|---|---|---|
| `nova-2-lite` | `us.amazon.nova-2-lite-v1:0` | `jp.amazon.nova-2-lite-v1:0` |
| `claude-haiku-4-5` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `claude-sonnet-4-6` | `us.anthropic.claude-sonnet-4-6` | `jp.anthropic.claude-sonnet-4-6` |
| `claude-sonnet-5` | `us.anthropic.claude-sonnet-5` | `global.anthropic.claude-sonnet-5` |
| `gpt-oss-20b` | `openai.gpt-oss-20b-1:0` | 同左 |
| `gpt-oss-120b` | `openai.gpt-oss-120b-1:0` | 同左 |
| `gpt-5-6-luna` | `us.openai.gpt-5.6-luna` | `global.openai.gpt-5.6-luna` |
| `glm-4-7-flash` | `zai.glm-4.7-flash` | 同左 |
| `glm-4-7` | `zai.glm-4.7` | 同左 |
| `gemini-3-5-flash` | `gemini-3.5-flash` | 同左 |

`global.*`は東京リージョンのRuntimeから呼び出せるが、推論処理を国内に限定する指定ではない。国内処理が要件なら、Global IDを有効化する前にモデルの推論先を確認する。

Geo／Global推論プロファイルは複数リージョンの基盤モデルへ転送されるため、CDKは`bedrock:InvokeModel`と`bedrock:CountTokens`のResourceを「指定された基盤モデルID」まで限定し、ARNのリージョン部分だけを`*`にする。モデルIDやAction全体をワイルドカードにはしない。

## Knowledge Base配列

各有効エントリをRuntimeの直接検索ツールとして登録し、`knowledge-base-search`ターゲットにも同じ配列を渡す。`key`と`toolName`は重複不可。`numberOfResults`は1～10。リージョン越境は`allowCrossRegionKnowledgeBases`が`true`の場合だけ許可する。

```json
{
  "key": "internal-documents",
  "enabled": true,
  "region": "ap-northeast-1",
  "knowledgeBaseId": "ABCDEFGHIJ",
  "toolName": "search_internal_documents",
  "description": "社内文書を検索する",
  "numberOfResults": 5
}
```

## Gatewayターゲット配列

環境configは、コード側カタログに登録済みのターゲットだけを有効化できる。任意コード、任意IAM権限、秘密値はconfigへ入れない。登録キーは`support-directory`と`knowledge-base-search`である。

```json
{
  "key": "support-directory",
  "enabled": true,
  "timeoutSeconds": 5,
  "memorySizeMb": 128,
  "environmentVariables": {}
}
```

`knowledge-base-search`は`knowledgeBaseKey`で検索先を選ぶ。`metadataKey`と`metadataValue`を両方指定すると、S3データソースに付随するmetadata JSONの文字列値をBedrock `equals`フィルターへ渡す。片方だけの指定、未登録のKnowledge Baseキー、取得件数の範囲外はLambdaで拒否する。`KNOWLEDGE_BASES_JSON`はCDKが設定する予約済み環境変数であり、configから上書きできない。

S3データソースでは、元文書と同じ場所へ`<元ファイル名>.metadata.json`を配置してからデータソースを同期する。次の簡略形式で登録した文字列属性を検索時の`metadataKey`と`metadataValue`に指定できる。形式と制約は[AWS公式のS3データソース仕様](https://docs.aws.amazon.com/bedrock/latest/userguide/s3-data-source-connector.html)を参照する。

```json
{
  "metadataAttributes": {
    "department": "sales",
    "documentType": "policy"
  }
}
```

## 追加Runtime配列

このStackが作成するRuntimeは`primary`として`runtime-config.json`へ自動登録される。既存Runtimeを同じUIから選べるようにする場合だけ`additionalRuntimes`へ追加する。

```json
"additionalRuntimes": [
  {
    "id": "document-agent",
    "name": "文書アシスタント",
    "description": "文書検索用Runtime",
    "runtimeId": "document_agent-AbCdEf1234",
    "region": "us-east-1",
    "qualifier": "DEFAULT"
  },
  {
    "id": "workflow-agent",
    "name": "申請アシスタント",
    "description": "申請処理用Runtime",
    "runtimeId": "workflow_agent-ZyXwVu9876",
    "region": "ap-northeast-1",
    "accountId": "123456789012",
    "qualifier": "DEFAULT"
  }
]
```

各要素の`id`はUI内部の安定識別子であり、`primary`は予約済みである。
`runtimeId`を使う場合は`region`が必須で、`accountId`を省略するとデプロイ先アカウントをCDKが設定する。
別アカウントのRuntimeには12桁の`accountId`を明示する。
完全な`runtimeArn`を指定する形式も利用できるが、同じ要素に`runtimeId`を併記できない。

追加Runtimeは、このUIと同じCognito Access Tokenを受け入れ、AG-UIと同じモデル選択コンテキストを解釈できる必要がある。
Runtime切替時は表示中の会話Runtimeを作り直すため、実行中またはHuman in the loopの回答待ち中は切り替えられない。

## 費用と価格

`monthlyBudgetUsd`はDynamoDBの`APP#<正規化済みdefaultCdkPrefix>/CONFIG`へCDKが反映する。月途中の変更も、再デプロイ後の次回呼び出し判定から使われる。アカウント、プロジェクト、ユーザーごとの別上限は持たない。

Cognito提供ドメインは`<正規化済みdefaultCdkPrefix>-<CloudFormation Stack IDのUUID先頭8文字>`としてCDKが生成する。同じStackを更新する限り維持され、削除・再作成時に変わる。

価格表はCDKアセットとしてVersioning付きS3へ配置する。Runtimeはモデル呼び出し時に価格表を読み、使用したS3 Version IDと単価を費用ログへ保存する。`priceVerificationEnabled`は照合機能の有無だけを変え、照合結果は呼び出し可否や価格表を変更しない。

`costDashboardEnabled=false`では費用・トークン用Metric Filter、CloudWatch Dashboard、Dashboard名のCloudFormation Outputを作成しない。Runtime Logs、DynamoDB費用台帳、価格照合Alarmには影響しない。現在のログ配送経路ではDashboardへ実績値が反映されないため、修正するまでは`false`を使用する。

## 適用方法

既存の`scripts/deploy-config.json`に`modelIds`がない場合は、同じリージョンの最新サンプルからこの項目をコピーしてからdiffを実行する。欠落したままではデプロイスクリプトが停止する。

```powershell
npm run deploy:diff
npm run deploy
```

`knowledgeBases`、`gatewayTargets`、`additionalRuntimes`などの配列はデプロイスクリプトがBase64URL化してCDK contextへ渡す。これはコマンドラインでJSON構造を壊さないための表現であり、秘匿化ではない。
