# Bedrockモデル利用契約の事前準備

## 責務の分離

第三者モデルの利用契約は、AWSアカウント管理者が利用条件を確認して一度だけ行う事前作業とする。CDKには契約作成・削除を含めない。CDKが管理するのは、契約済みモデルを呼び出すRuntimeのIAM権限と`enabledModelKeys`によるアプリ表示だけである。

この分離により、インフラ更新が意図せず利用規約へ同意したり、契約を解除したりすることを防ぐ。

## 利用可否の確認

モデルカタログの`availabilityModelId`を使い、デプロイ先リージョンで状態を確認する。

```powershell
aws bedrock get-foundation-model-availability `
  --model-id <MODEL_ID> `
  --region <AWS_REGION> `
  --profile default
```

次のすべてを確認する。

- `agreementAvailability.status`が`AVAILABLE`
- `authorizationStatus`が`AUTHORIZED`
- `entitlementAvailability`が`AVAILABLE`
- `regionAvailability`が`AVAILABLE`

いずれかが満たされない場合、そのモデルの呼び出しは失敗する。`enabledModelKeys`はアプリの表示・入力検証・IAM許可を揃えるallowlistであり、契約状態を自動判定する設定ではない。契約前に一覧へ出して疎通確認する運用も可能だが、選択時のエラーを許容することを明示する。

## 契約が未完了の場合

AWS Bedrockコンソールで対象モデルのEULAを権限者が確認する。CLIで契約する場合も、次の操作より前に同じ利用条件を確認し、同意する権限がある担当者が実行する。

```powershell
aws bedrock list-foundation-model-agreement-offers `
  --model-id <MODEL_ID> `
  --offer-type ALL `
  --region <AWS_REGION> `
  --profile admin

aws bedrock create-foundation-model-agreement `
  --model-id <MODEL_ID> `
  --offer-token <OFFER_TOKEN> `
  --region <AWS_REGION> `
  --profile admin
```

`OFFER_TOKEN`は作業ログや設計書へ保存しない。Anthropicをアカウントで初めて利用する場合は、契約前にユースケース申請が別途必要になる。

契約後、利用可否の確認コマンドを再実行する。状態反映には時間がかかる場合がある。未登録のモデルを一覧へ追加する場合は、`scripts/deploy-config.json`の`enabledModelKeys`へ対象キーを追加して`npm run deploy:diff`、`npm run deploy`の順に反映する。すでに一覧へ出している場合、契約状態の反映だけを目的とした再デプロイは不要である。

## 現在の第三者Bedrockモデル

| configキー | 利用可否確認用モデルID | 呼び出し経路 |
|---|---|---|
| `gpt-5-6-luna` | `openai.gpt-5.6-luna` | US Geo推論ID |
| `gpt-oss-20b` | `openai.gpt-oss-20b-1:0` | 配置リージョンの基盤モデル |
| `gpt-oss-120b` | `openai.gpt-oss-120b-1:0` | 配置リージョンの基盤モデル |
| `glm-4-7-flash` | `zai.glm-4.7-flash` | 配置リージョンの基盤モデル |
| `glm-4-7` | `zai.glm-4.7` | 配置リージョンの基盤モデル |

利用契約はモデル単位、リージョン単位で確認する。モデルを一覧へ表示できることやCDKデプロイが成功することは、推論を実行できる証明にはならない。

## GPT-5.6 Luna

- configキー: `gpt-5-6-luna`
- 利用可否確認用モデルID: `openai.gpt-5.6-luna`
- Runtime呼び出し: Bedrock Converse APIとUS Geo推論IDを使用
- CountTokens: Bedrock非対応のため、SDK概算へ切り替えたことをRuntimeログへ記録
- IAM: Geo推論プロファイル、配下の基盤モデル、アカウントの`default` projectをCDKで許可
- 価格: 入力272,000トークン以下と、それを超えて1,000,000トークン以下の2段階を公式モデルカードに合わせて計算

東京リージョンのBedrock RuntimeからLunaを使う場合、US Geo推論IDは利用できない。国内処理が必須でなければGlobal推論IDを使う別設定が必要になるため、現在の`gpt-5-6-luna`キーはUSリージョン用とする。
