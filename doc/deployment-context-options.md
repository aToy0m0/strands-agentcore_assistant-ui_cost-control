# デプロイ設定一覧

最終更新日: 2026-09-06

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

各有効エントリを独立した検索ツールとしてRuntimeへ登録する。`key`と`toolName`は重複不可。`numberOfResults`は1～10。リージョン越境は`allowCrossRegionKnowledgeBases`が`true`の場合だけ許可する。

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

環境configは、コード側カタログに登録済みのターゲットだけを有効化できる。任意コード、任意IAM権限、秘密値はconfigへ入れない。現在の登録キーは`support-directory`。

```json
{
  "key": "support-directory",
  "enabled": true,
  "timeoutSeconds": 5,
  "memorySizeMb": 128,
  "environmentVariables": {}
}
```

## 費用と価格

`monthlyBudgetUsd`はDynamoDBの`APP#<正規化済みdefaultCdkPrefix>/CONFIG`へCDKが反映する。月途中の変更も、再デプロイ後の次回呼び出し判定から使われる。アカウント、プロジェクト、ユーザーごとの別上限は持たない。

Cognito提供ドメインは`<正規化済みdefaultCdkPrefix>-<CloudFormation Stack IDのUUID先頭8文字>`としてCDKが生成する。同じStackを更新する限り維持され、削除・再作成時に変わる。

価格表はCDKアセットとしてVersioning付きS3へ配置する。Runtimeはモデル呼び出し時に価格表を読み、使用したS3 Version IDと単価を費用ログへ保存する。`priceVerificationEnabled`は照合機能の有無だけを変え、照合結果は呼び出し可否や価格表を変更しない。

## 適用方法

既存の`scripts/deploy-config.json`に`modelIds`がない場合は、同じリージョンの最新サンプルからこの項目をコピーしてからdiffを実行する。欠落したままではデプロイスクリプトが停止する。

```powershell
npm run deploy:diff
npm run deploy
```

配列はデプロイスクリプトがBase64URL化してCDK contextへ渡す。これはコマンドラインでJSON構造を壊さないための表現であり、秘匿化ではない。
