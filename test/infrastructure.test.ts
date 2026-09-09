import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { decodeBase64UrlContext, AgentCoreCostControlStack, pricingCatalogForModelIds, resolveLogRetention, resolveMonthlyBudgetNanoUsd, resolveWebDebugMode } from "../infrastructure/stack.js";
import { resolveResourceNames, resolveRuntimeDisplayName } from "../infrastructure/naming.js";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

function template(context: Record<string, unknown> = {}) {
  const app = new App({ context: {
    defaultCdkPrefix: "Agent-Core-Runtime_Cost-control",
    runtimeDisplayName: "AIエージェント",
    customDomainEnabled: true,
    customDomainName: "agent.example.com",
    hostedZoneId: "Z1234567890ABC",
    hostedZoneName: "example.com",
    certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000003",
    knowledgeBases: JSON.stringify([{
      key: "internal-documents",
      enabled: true,
      region: "us-east-1",
      knowledgeBaseId: "ABCDEFGHIJ",
      toolName: "search_internal_documents",
      description: "Search internal documents",
      numberOfResults: 5,
    }]),
    gatewayTargets: JSON.stringify([{
      key: "support-directory",
      enabled: true,
      timeoutSeconds: 5,
      memorySizeMb: 128,
      environmentVariables: {},
    }]),
    enabledModelKeys: JSON.stringify([
      "nova-2-lite", "claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-5",
      "gpt-oss-20b", "gpt-oss-120b", "gpt-5-6-luna", "glm-4-7-flash", "glm-4-7",
    ]),
    modelIds: JSON.stringify({
      "nova-2-lite": "us.amazon.nova-2-lite-v1:0",
      "claude-haiku-4-5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6",
      "claude-sonnet-5": "us.anthropic.claude-sonnet-5",
      "gpt-oss-20b": "openai.gpt-oss-20b-1:0",
      "gpt-oss-120b": "openai.gpt-oss-120b-1:0",
      "gpt-5-6-luna": "us.openai.gpt-5.6-luna",
      "glm-4-7-flash": "zai.glm-4.7-flash",
      "glm-4-7": "zai.glm-4.7",
      "gemini-3-5-flash": "gemini-3.5-flash",
    }),
    ...context,
  } });
  return Template.fromStack(new AgentCoreCostControlStack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  }));
}

function entraContext() {
  return {
    entraEnabled: true,
    entraTenantId: "00000000-0000-0000-0000-000000000001",
    entraClientId: "00000000-0000-0000-0000-000000000002",
    entraClientSecretName: "sample/entra/client-secret",
  };
}

describe("AgentCoreCostControlStack", () => {
  it("Cognito認証・静的Web・CodeZip Runtimeだけを構築する", () => {
    const value = template();
    value.resourceCountIs("AWS::Cognito::UserPool", 1);
    value.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    value.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
    value.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
    value.resourceCountIs("AWS::BedrockAgentCore::Runtime", 1);
    value.resourceCountIs("AWS::CloudFront::Distribution", 1);
    value.resourceCountIs("AWS::DynamoDB::Table", 1);
    value.resourceCountIs("AWS::Route53::RecordSet", 1);
    value.resourceCountIs("AWS::RDS::DBInstance", 0);
    value.resourceCountIs("AWS::Lambda::Url", 0);
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      ProtocolConfiguration: "AGUI",
      AgentRuntimeArtifact: { CodeConfiguration: Match.objectLike({ Runtime: "NODE_22", EntryPoint: ["dist/app.js"] }) },
      AuthorizerConfiguration: { CustomJWTAuthorizer: Match.objectLike({ AllowedClients: Match.anyValue() }) },
    }));
    value.hasResourceProperties("AWS::BedrockAgentCore::Memory", {
      Name: "agent_core_runtime_cost_control_memory",
    });
  });

  it("リソース接頭辞と安定した費用集計IDを使う", () => {
    const value = template({ defaultCdkPrefix: "Sample_21" });
    value.hasResourceProperties("AWS::Lambda::Function", Match.objectLike({ FunctionName: "sample-21-support-directory-tool" }));
    value.hasResourceProperties("AWS::BedrockAgentCore::Gateway", Match.objectLike({ Name: "sample-21-tools" }));
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      AgentRuntimeName: "sample_21_runtime",
      EnvironmentVariables: Match.objectLike({ BUDGET_SCOPE_ID: "sample-21" }),
    }));
  });

  it("タグ対応リソースへCostGroupタグを設定する", () => {
    const value = template({ defaultCdkPrefix: "Sample_21" });
    const costGroupTag = { Key: "CostGroup", Value: "sample-21" };
    value.hasResourceProperties("AWS::S3::Bucket", Match.objectLike({ Tags: Match.arrayWith([costGroupTag]) }));
    value.hasResourceProperties("AWS::DynamoDB::Table", Match.objectLike({ Tags: Match.arrayWith([costGroupTag]) }));
    value.hasResourceProperties("AWS::Lambda::Function", Match.objectLike({ Tags: Match.arrayWith([costGroupTag]) }));
  });

  it("リソース接頭辞とUI名の不正値を拒否する", () => {
    expect(resolveResourceNames("Sample_21").base).toBe("sample-21");
    expect(resolveResourceNames("123 Sample").base).toBe("app-123-sample");
    expect(resolveResourceNames("This_is_a_very_long_resource_name_that_needs_shortening").base)
      .toMatch(/^this-is-a-very-long-res-[a-f0-9]{8}$/u);
    expect(() => resolveResourceNames("Sample@21")).toThrow("defaultCdkPrefix");
    expect(resolveRuntimeDisplayName("  社内アシスタント  ")).toBe("社内アシスタント");
    expect(() => resolveRuntimeDisplayName(" ")).toThrow("runtimeDisplayName");
  });

  it("既存証明書をCloudFrontへ設定し、既存Hosted ZoneへAlias Aレコードだけを追加する", () => {
    const value = template();
    value.hasResourceProperties("AWS::CloudFront::Distribution", Match.objectLike({
      DistributionConfig: Match.objectLike({
        Aliases: ["agent.example.com"],
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000003",
          MinimumProtocolVersion: "TLSv1.2_2021",
        }),
      }),
    }));
    value.hasResourceProperties("AWS::Route53::RecordSet", Match.objectLike({
      HostedZoneId: "Z1234567890ABC",
      Name: "agent.example.com.",
      Type: "A",
      AliasTarget: Match.objectLike({ DNSName: Match.anyValue() }),
    }));
    value.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    value.resourceCountIs("AWS::Route53::HostedZone", 0);
  });

  it("カスタムドメインがHosted Zone配下でなければ拒否する", () => {
    expect(() => template({ customDomainName: "agent.other.example" })).toThrow("must be a subdomain");
  });

  it("カスタムドメイン無効時は証明書設定なしでCloudFront標準ドメインを使う", () => {
    const value = template({
      customDomainEnabled: false,
      customDomainName: undefined,
      hostedZoneId: undefined,
      hostedZoneName: undefined,
      certificateArn: undefined,
    });
    value.resourceCountIs("AWS::Route53::RecordSet", 0);
    value.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.not(Match.objectLike({ Aliases: Match.anyValue() })),
    });
  });

  it("カスタムドメイン有効時は証明書ARNがなければ拒否する", () => {
    expect(() => template({ certificateArn: undefined })).toThrow("certificateArn is required");
  });

  it("アプリ月額上限をDynamoDB設定へ配置しRuntimeには集計IDだけを渡す", () => {
    const value = template({ defaultCdkPrefix: "Stable-Budget", monthlyBudgetUsd: "25.5" });
    value.hasResourceProperties("AWS::DynamoDB::Table", Match.objectLike({
      BillingMode: "PAY_PER_REQUEST",
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    }));
    const customResources = JSON.stringify(value.findResources("Custom::AWS"));
    expect(customResources).toContain("APP#stable-budget");
    expect(customResources).toContain("CONFIG");
    expect(customResources).toContain("25500000000");
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      EnvironmentVariables: Match.objectLike({
        BUDGET_SCOPE_ID: "stable-budget",
        BUDGET_TABLE_NAME: Match.anyValue(),
      }),
    }));
  });

  it("モデル価格をVersioning付きS3へ置き、Runtimeへ読み取りだけを許可する", () => {
    const value = template();
    value.hasResourceProperties("AWS::S3::Bucket", Match.objectLike({
      VersioningConfiguration: { Status: "Enabled" },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    }));
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      EnvironmentVariables: Match.objectLike({
        PRICING_CATALOG_BUCKET_NAME: Match.anyValue(),
        PRICING_CATALOG_OBJECT_KEY: "catalog/model-pricing.json",
      }),
    }));
    const policies = JSON.stringify(value.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("s3:GetObject");
    expect(policies).toContain("PricingCatalogBucket");
  });

  it("公式Price Listと日次照合し、不一致をログメトリクスとAlarmで通知する", () => {
    const value = template({ priceVerificationEnabled: true });
    value.hasResourceProperties("AWS::Lambda::Function", Match.objectLike({
      Handler: "index.lambda_handler",
      Runtime: "python3.13",
      Timeout: 120,
      Environment: { Variables: Match.objectLike({
        PRICING_CATALOG_BUCKET_NAME: Match.anyValue(),
        PRICING_CATALOG_OBJECT_KEY: "catalog/model-pricing.json",
      }) },
    }));
    value.hasResourceProperties("AWS::Events::Rule", Match.objectLike({
      ScheduleExpression: "cron(0 15 * * ? *)",
      State: "ENABLED",
    }));
    value.hasResourceProperties("AWS::Logs::MetricFilter", Match.objectLike({
      FilterPattern: '{ $.event = "pricing.verification.warning" }',
      MetricTransformations: [Match.objectLike({
        MetricName: "PricingVerificationWarnings",
        MetricNamespace: "agent-core-runtime-cost-control",
        MetricValue: "1",
      })],
    }));
    value.hasResourceProperties("AWS::CloudWatch::Alarm", Match.objectLike({
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      MetricName: "PricingVerificationWarnings",
      Namespace: "agent-core-runtime-cost-control",
      Threshold: 1,
      TreatMissingData: "notBreaching",
    }));
    const templateJson = JSON.stringify(value.toJSON());
    expect(templateJson).toContain("pricing:GetProducts");
  });

  it("価格照合を無効にした環境ではLambdaとAlarmを作らない", () => {
    const value = template({ priceVerificationEnabled: false });
    value.resourceCountIs("AWS::Events::Rule", 0);
    value.resourceCountIs("AWS::CloudWatch::Alarm", 0);
  });

  it("モデル費用とトークン数の専用CloudWatch Dashboardを作る", () => {
    const value = template({ costDashboardEnabled: true });
    value.hasResourceProperties("AWS::Logs::MetricFilter", Match.objectLike({
      MetricTransformations: [Match.objectLike({ MetricName: "SettledModelCostUsd", MetricValue: "$.actualUsd" })],
    }));
    value.hasResourceProperties("AWS::Logs::MetricFilter", Match.objectLike({
      MetricTransformations: [Match.objectLike({ MetricName: "SettledModelTokens", MetricValue: "$.actualTokens" })],
    }));
    value.hasResourceProperties("AWS::CloudWatch::Dashboard", Match.objectLike({
      DashboardName: "agent-core-runtime-cost-control-model-cost",
    }));
  });

  it("費用Dashboardを無効にした環境ではDashboardと専用Metric Filterを作らない", () => {
    const value = template({ costDashboardEnabled: false });
    value.resourceCountIs("AWS::CloudWatch::Dashboard", 0);
    const metricFilters = JSON.stringify(value.findResources("AWS::Logs::MetricFilter"));
    expect(metricFilters).not.toContain("SettledModelCostUsd");
    expect(metricFilters).not.toContain("SettledModelTokens");
    expect(value.toJSON().Outputs?.CostDashboardName).toBeUndefined();
  });

  it("費用Dashboard設定のboolean以外を拒否する", () => {
    expect(() => template({ costDashboardEnabled: "yes" })).toThrow("costDashboardEnabled must be true or false");
  });

  it("旧ユーザー上限グループを再生成しない", () => {
    const value = template();
    value.resourceCountIs("AWS::Cognito::UserPoolGroup", 0);
  });

  it("デプロイスクリプト用Base64URLコンテキストを復号する", () => {
    const json = '[{"id":"default","default":true,"window":"monthly","tokenLimit":1000}]';
    const encoded = Buffer.from(json).toString("base64url");
    expect(decodeBase64UrlContext(encoded, "profiles")).toBe(json);
    expect(() => decodeBase64UrlContext(`${encoded}=`, "profiles")).toThrow("base64url");
  });

  it("Bedrockモデルへ推論と事前CountTokens権限を付ける", () => {
    const policies = JSON.stringify(template().findResources("AWS::IAM::Policy"));
    expect(policies).toContain("claude-haiku-4-5");
    expect(policies).toContain("claude-sonnet-4-6");
    expect(policies).toContain("claude-sonnet-5");
    expect(policies).toContain('"bedrock:CountTokens"');
    expect(policies).toContain("nova-2-lite");
    expect(policies).toContain("gpt-oss");
    expect(policies).toContain("gpt-5.6-luna");
    expect(policies).toContain("project/default");
    expect(policies).toContain("glm-4.7");
  });

  it("configのモデルIDをRuntime、価格表、IAMへ一貫して反映する", () => {
    const value = template({
      enabledModelKeys: JSON.stringify(["claude-sonnet-5"]),
      modelIds: JSON.stringify({ "claude-sonnet-5": "global.anthropic.claude-sonnet-5" }),
    });
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      EnvironmentVariables: Match.objectLike({
        MODEL_IDS_JSON: JSON.stringify({ "claude-sonnet-5": "global.anthropic.claude-sonnet-5" }),
      }),
    }));
    const templateJson = JSON.stringify(value.toJSON());
    expect(templateJson).toContain("inference-profile/global.anthropic.claude-sonnet-5");
    expect(templateJson).toContain(":bedrock:*::foundation-model/anthropic.claude-sonnet-5");
    expect(pricingCatalogForModelIds({ "claude-sonnet-5": "global.anthropic.claude-sonnet-5" }).models)
      .toHaveProperty("global.anthropic.claude-sonnet-5");
  });

  it("有効モデルのID欠落と未知モデルIDキーを拒否する", () => {
    expect(() => template({ enabledModelKeys: JSON.stringify(["claude-sonnet-5"]), modelIds: "{}" }))
      .toThrow("modelIds.claude-sonnet-5");
    expect(() => template({ modelIds: JSON.stringify({ unknown: "example.model" }) }))
      .toThrow("unknown model key");
  });

  it("Gemini有効時だけSecrets ManagerのAPIキー参照をRuntimeへ許可する", () => {
    const enabled = template({
      geminiEnabled: true,
      geminiApiKeySecretName: "assistant/gemini-api-key",
      enabledModelKeys: JSON.stringify(["gemini-3-5-flash"]),
    });
    enabled.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      EnvironmentVariables: Match.objectLike({ GEMINI_API_KEY_SECRET_NAME: "assistant/gemini-api-key" }),
    }));
    expect(JSON.stringify(enabled.findResources("AWS::IAM::Policy"))).toContain("secretsmanager:GetSecretValue");
    expect(() => template({ geminiEnabled: true })).toThrow("geminiApiKeySecretName");
  });

  it("不正な月額上限をsynth前に拒否する", () => {
    expect(() => resolveMonthlyBudgetNanoUsd("0", "100", "budget")).toThrow("greater than zero");
    expect(() => resolveMonthlyBudgetNanoUsd("1.0000000001", "100", "budget")).toThrow("must be a non-negative USD amount");
  });

  it("Runtime実行ロールへMemory暗号化キーの利用権限を付ける", () => {
    const value = template();
    value.hasResourceProperties("AWS::IAM::Policy", Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "kms:DescribeKey",
            Resource: { "Fn::GetAtt": [Match.stringLikeRegexp("MemoryKey"), "Arn"] },
          }),
        ]),
      }),
    }));
  });

  it("configで有効にした複数Knowledge BaseだけをRuntimeへ接続する", () => {
    const knowledgeBases = [
      { key: "us-docs", enabled: true, region: "us-east-1", knowledgeBaseId: "ABCDEFGHIJ", toolName: "search_us_docs", description: "US docs", numberOfResults: 4 },
      { key: "tokyo-docs", enabled: true, region: "ap-northeast-1", knowledgeBaseId: "KLMNOPQRST", toolName: "search_tokyo_docs", description: "Tokyo docs", numberOfResults: 6 },
      { key: "disabled-docs", enabled: false, region: "us-east-1", knowledgeBaseId: "UVWXYZ1234", toolName: "search_disabled_docs", description: "Disabled docs", numberOfResults: 5 },
    ];
    const value = template({
      knowledgeBases: JSON.stringify(knowledgeBases),
      allowCrossRegionKnowledgeBases: true,
    });
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      EnvironmentVariables: Match.objectLike({ KNOWLEDGE_BASES_JSON: JSON.stringify(knowledgeBases) }),
    }));
    const policies = value.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const retrieveStatements = statements.filter((statement) => statement.Action === "bedrock:Retrieve");
    expect(retrieveStatements).toHaveLength(1);
    const resources = JSON.stringify(retrieveStatements[0].Resource);
    expect(resources).toContain(":bedrock:us-east-1:123456789012:knowledge-base/ABCDEFGHIJ");
    expect(resources).toContain(":bedrock:ap-northeast-1:123456789012:knowledge-base/KLMNOPQRST");
    expect(resources).not.toContain("UVWXYZ1234");
  });

  it("Knowledge Baseのリージョン越境は明示許可なしでは拒否する", () => {
    expect(() => template({
      knowledgeBases: JSON.stringify([{
        key: "tokyo-docs", enabled: true, region: "ap-northeast-1", knowledgeBaseId: "KLMNOPQRST",
        toolName: "search_tokyo_docs", description: "Tokyo docs", numberOfResults: 5,
      }]),
    })).toThrow("AllowCrossRegionKnowledgeBases=true");
  });

  it("Gateway Lambdaの実行設定をconfigから適用する", () => {
    const value = template({ gatewayTargets: JSON.stringify([{
      key: "support-directory",
      enabled: true,
      timeoutSeconds: 12,
      memorySizeMb: 256,
      environmentVariables: { DIRECTORY_MODE: "readonly" },
    }]) });
    value.hasResourceProperties("AWS::Lambda::Function", Match.objectLike({
      FunctionName: "agent-core-runtime-cost-control-support-directory-tool",
      Timeout: 12,
      MemorySize: 256,
      Environment: { Variables: { DIRECTORY_MODE: "readonly" } },
    }));
    expect(value.toJSON().Resources.GatewayTool7C2912AF).toBeDefined();
    value.resourceCountIs("AWS::BedrockAgentCore::GatewayTarget", 1);
  });

  it("Knowledge Base Gateway Lambdaへ設定・metadata検索権限・保持期間を適用する", () => {
    const value = template({
      logRetentionDays: 14,
      gatewayTargets: JSON.stringify([{
        key: "knowledge-base-search",
        enabled: true,
        timeoutSeconds: 15,
        memorySizeMb: 256,
        environmentVariables: {},
      }]),
    });
    value.hasResourceProperties("AWS::Lambda::Function", Match.objectLike({
      FunctionName: "agent-core-runtime-cost-control-knowledge-base-search-tool",
      Timeout: 15,
      MemorySize: 256,
      Environment: { Variables: Match.objectLike({ KNOWLEDGE_BASES_JSON: Match.stringLikeRegexp("internal-documents") }) },
    }));
    value.hasResourceProperties("AWS::Logs::LogGroup", Match.objectLike({
      LogGroupName: "/agent-core-runtime-cost-control/tools/knowledge-base-search",
      RetentionInDays: 14,
    }));
    const policies = value.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    expect(statements.some((statement) => statement.Action === "bedrock:Retrieve"
      && JSON.stringify(statement.Resource).includes("knowledge-base/ABCDEFGHIJ"))).toBe(true);
    value.resourceCountIs("AWS::BedrockAgentCore::GatewayTarget", 1);
  });

  it("Knowledge Base Gateway Lambdaの管理用環境変数を上書きさせない", () => {
    expect(() => template({ gatewayTargets: JSON.stringify([{
      key: "knowledge-base-search",
      enabled: true,
      timeoutSeconds: 15,
      memorySizeMb: 256,
      environmentVariables: { KNOWLEDGE_BASES_JSON: "[]" },
    }]) })).toThrow("must not override KNOWLEDGE_BASES_JSON");
  });

  it("Gateway targetの未知キーを拒否する", () => {
    expect(() => template({ gatewayTargets: JSON.stringify([{
      key: "unknown-tool", enabled: true, timeoutSeconds: 5, memorySizeMb: 128, environmentVariables: {},
    }]) })).toThrow("unknown catalog key");
  });

  it("複数の外部Runtime IDを追加設定できる", () => {
    expect(() => template({ additionalRuntimes: JSON.stringify([
      {
        id: "document-agent",
        name: "Document agent",
        description: "US runtime",
        runtimeId: "document_agent-AbCdEf1234",
        region: "us-east-1",
      },
      {
        id: "workflow-agent",
        name: "Workflow agent",
        description: "Tokyo runtime",
        runtimeId: "workflow_agent-ZyXwVu9876",
        region: "ap-northeast-1",
        accountId: "210987654321",
      },
    ]) })).not.toThrow();
  });

  it("Entraオプション有効時だけOIDC IdPを追加する", () => {
    expect(template().toJSON().Outputs?.EntraRedirectUri).toBeUndefined();
    const value = template({
      entraEnabled: true,
      entraTenantId: "00000000-0000-0000-0000-000000000001",
      entraClientId: "00000000-0000-0000-0000-000000000002",
      entraClientSecretName: "sample/entra/client-secret",
    });
    value.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 1);
    expect(value.toJSON().Outputs?.EntraRedirectUri).toBeDefined();
    value.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "MicrosoftEntraID",
      ProviderType: "OIDC",
      ProviderDetails: Match.objectLike({
        authorize_scopes: "openid email",
        oidc_issuer: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0",
      }),
      AttributeMapping: { email: "email", username: "sub" },
    });
  });

  it("Entra必須入力が欠けていればsynthを拒否する", () => {
    expect(() => template({ entraEnabled: true })).toThrow("entraTenantId");
  });

  it("Entraを無効にしたままEntra表示を指定すればsynthを拒否する", () => {
    expect(() => template({ loginMethods: "entra" }))
      .toThrow("requires entraEnabled=true");
  });

  it("未知のloginMethodsはsynthを拒否する", () => {
    expect(() => template({ loginMethods: "saml" }))
      .toThrow("loginMethods must be one of");
  });

  it("loginMethods=entraならApp Client側でもCognitoログインを塞ぐ", () => {
    const value = template({ ...entraContext(), loginMethods: "entra" });
    value.hasResourceProperties("AWS::Cognito::UserPoolClient", Match.objectLike({
      SupportedIdentityProviders: ["MicrosoftEntraID"],
      // 空にするとExplicitAuthFlowsが消えCognitoの既定（SRP等）が復活するため、明示が必要
      ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
    }));
  });

  it("loginMethods=cognitoならEntraをApp Clientから外す", () => {
    const value = template({ ...entraContext(), loginMethods: "cognito" });
    value.hasResourceProperties("AWS::Cognito::UserPoolClient", Match.objectLike({
      SupportedIdentityProviders: ["COGNITO"],
      ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    }));
  });

  it("両方表示なら両方を許可し、USER_PASSWORD_AUTHは許可しない", () => {
    const value = template({ ...entraContext(), loginMethods: "cognito-and-entra" });
    value.hasResourceProperties("AWS::Cognito::UserPoolClient", Match.objectLike({
      SupportedIdentityProviders: ["COGNITO", "MicrosoftEntraID"],
      ExplicitAuthFlows: Match.not(Match.arrayWith(["ALLOW_USER_PASSWORD_AUTH"])),
    }));
  });
});

describe("ログ出力", () => {
  it("既定で保持期間3日のロググループとAPPLICATION_LOGS/USAGE_LOGSの配信を作る", () => {
    const value = template();
    value.hasResourceProperties("AWS::Logs::LogGroup", Match.objectLike({ RetentionInDays: 3 }));
    value.resourceCountIs("AWS::Logs::Delivery", 2);
    const sources = value.findResources("AWS::Logs::DeliverySource");
    const logTypes = Object.values(sources).map((resource) => resource.Properties.LogType).sort();
    expect(logTypes).toEqual(["APPLICATION_LOGS", "USAGE_LOGS"]);
  });

  it("実行ロールへCloudWatch Logsの書き込み権限を付ける", () => {
    const value = template();
    value.hasResourceProperties("AWS::IAM::Policy", Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(["logs:CreateLogStream", "logs:PutLogEvents"]) }),
        ]),
      }),
    }));
  });

  it("logRetentionDaysで保持期間を変更できる", () => {
    const value = template({ logRetentionDays: 30 });
    value.hasResourceProperties("AWS::Logs::LogGroup", Match.objectLike({ RetentionInDays: 30 }));
    const logGroups = Object.values(value.findResources("AWS::Logs::LogGroup"));
    expect(logGroups.every((resource) => resource.Properties.RetentionInDays === 30)).toBe(true);
    expect(JSON.stringify(logGroups)).toContain("/aws/bedrock-agentcore/runtimes/");
  });

  it("CloudWatch Logsが受け付けない保持期間は拒否する", () => {
    expect(() => resolveLogRetention(4)).toThrow("logRetentionDays must be one of");
    expect(() => resolveLogRetention("abc")).toThrow("logRetentionDays must be one of");
    expect(resolveLogRetention(undefined)).toBe(RetentionDays.THREE_DAYS);
  });

  it("種別ごとのログをデプロイ時に無効化できる", () => {
    template({ runtimeLogModel: "off", runtimeLogTool: "off" })
      .hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
        EnvironmentVariables: Match.objectLike({ RUNTIME_LOG_MODEL: "off", RUNTIME_LOG_TOOL: "off" }),
      }));
  });

  it("未指定の種別は環境変数を設定せず既定の有効のままにする", () => {
    const runtimes = template().findResources("AWS::BedrockAgentCore::Runtime");
    const environment = Object.values(runtimes)[0]?.Properties.EnvironmentVariables ?? {};
    expect(environment).not.toHaveProperty("RUNTIME_LOG_MODEL");
    expect(environment).not.toHaveProperty("RUNTIME_LOG_TOOL");
  });

  it("on/off以外の指定は拒否する", () => {
    expect(() => template({ runtimeLogModel: "maybe" })).toThrow("must be on or off");
  });
});

describe("Webデバッグモード", () => {
  it("既定は無効でon/offを明示的に変換する", () => {
    expect(resolveWebDebugMode(undefined)).toBe(false);
    expect(resolveWebDebugMode("on")).toBe(true);
    expect(resolveWebDebugMode(true)).toBe(true);
    expect(resolveWebDebugMode("off")).toBe(false);
    expect(resolveWebDebugMode(false)).toBe(false);
  });

  it("on/off以外の指定は拒否する", () => {
    expect(() => resolveWebDebugMode("verbose")).toThrow("webDebugMode must be on or off");
  });
});
