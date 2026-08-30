# AgentCore CodeZip Runtime

AG-UIプロトコルに対応したNode.js 22向けCodeZipです。`POST /invocations`でAG-UI入力を受け、Strands AgentsのイベントをAG-UI SSEへ変換します。

```bash
npm ci
npm test
npm run package
```

生成物は`deployment_package.zip`です。リポジトリ直下のCDKが専用S3バケットを作成し、CloudFormationのBucketDeploymentでZIPをアップロードしてから`AWS::BedrockAgentCore::Runtime`を作成します。
