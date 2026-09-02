import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { decodeBase64UrlContext, WorkmateCostControlStack, resolveLogRetention, resolveMonthlyBudgetNanoUsd, resolveResourceNamePrefix, resolveUiName, resolveWebDebugMode } from "../infrastructure/stack.js";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

function template(context: Record<string, unknown> = {}) {
  const app = new App({ context: {
    resourceNamePrefix: "workmate-14",
    uiName: "Workmate",
    customDomainEnabled: true,
    customDomainName: "workmate14.example.com",
    hostedZoneId: "Z1234567890ABC",
    hostedZoneName: "example.com",
    certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000003",
    ...context,
  } });
  return Template.fromStack(new WorkmateCostControlStack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  }));
}

function entraContext() {
  return {
    cognitoDomainPrefix: "workmate12-entra-test",
    entraEnabled: true,
    entraTenantId: "00000000-0000-0000-0000-000000000001",
    entraClientId: "00000000-0000-0000-0000-000000000002",
    entraClientSecretName: "workmate12/entra/client-secret",
  };
}

describe("WorkmateCostControlStack", () => {
  it("Cognito認証・静的Web・CodeZip Runtimeだけを構築する", () => {
    const value = template({ cognitoDomainPrefix: "workmate12-test" });
    value.resourceCountIs("AWS::Cognito::UserPool", 1);
    value.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    value.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
    value.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
    value.resourceCountIs("AWS::BedrockAgentCore::Runtime", 1);
    value.resourceCountIs("AWS::CloudFront::Distribution", 1);
    value.resourceCountIs("AWS::DynamoDB::Table", 3);
    value.resourceCountIs("AWS::Route53::RecordSet", 1);
    value.resourceCountIs("AWS::RDS::DBInstance", 0);
    value.resourceCountIs("AWS::Lambda::Url", 0);
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      ProtocolConfiguration: "AGUI",
      AgentRuntimeArtifact: { CodeConfiguration: Match.objectLike({ Runtime: "NODE_22", EntryPoint: ["dist/app.js"] }) },
      AuthorizerConfiguration: { CustomJWTAuthorizer: Match.objectLike({ AllowedClients: Match.anyValue() }) },
    }));
    value.hasResourceProperties("AWS::BedrockAgentCore::Memory", {
      Name: "workmate_cost_control_memory",
    });
  });

  it("リソース接頭辞を明示名と費用台帳のプロジェクトIDへ統一して使う", () => {
    const value = template({ resourceNamePrefix: "sample-21", cognitoDomainPrefix: "sample21-test" });
    value.hasResourceProperties("AWS::Lambda::Function", Match.objectLike({ FunctionName: "sample-21-support-directory-tool" }));
    value.hasResourceProperties("AWS::BedrockAgentCore::Gateway", Match.objectLike({ Name: "sample-21-tools" }));
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      AgentRuntimeName: "sample_21_cost_control",
      EnvironmentVariables: Match.objectLike({ BUDGET_PROJECT_ID: "sample-21" }),
    }));
  });

  it("タグ対応リソースへCostGroupタグを設定する", () => {
    const value = template({ resourceNamePrefix: "sample-21", cognitoDomainPrefix: "sample21-cost-tag-test" });
    const costGroupTag = { Key: "CostGroup", Value: "sample-21" };
    value.hasResourceProperties("AWS::S3::Bucket", Match.objectLike({ Tags: Match.arrayWith([costGroupTag]) }));
    value.hasResourceProperties("AWS::DynamoDB::Table", Match.objectLike({ Tags: Match.arrayWith([costGroupTag]) }));
    value.hasResourceProperties("AWS::Lambda::Function", Match.objectLike({ Tags: Match.arrayWith([costGroupTag]) }));
  });

  it("リソース接頭辞とUI名の不正値を拒否する", () => {
    expect(resolveResourceNamePrefix("sample-21")).toBe("sample-21");
    expect(() => resolveResourceNamePrefix("Sample_21")).toThrow("resourceNamePrefix");
    expect(resolveUiName("  社内アシスタント  ")).toBe("社内アシスタント");
    expect(() => resolveUiName(" ")).toThrow("uiName");
  });

  it("既存証明書をCloudFrontへ設定し、既存Hosted ZoneへAlias Aレコードだけを追加する", () => {
    const value = template();
    value.hasResourceProperties("AWS::CloudFront::Distribution", Match.objectLike({
      DistributionConfig: Match.objectLike({
        Aliases: ["workmate14.example.com"],
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000003",
          MinimumProtocolVersion: "TLSv1.2_2021",
        }),
      }),
    }));
    value.hasResourceProperties("AWS::Route53::RecordSet", Match.objectLike({
      HostedZoneId: "Z1234567890ABC",
      Name: "workmate14.example.com.",
      Type: "A",
      AliasTarget: Match.objectLike({ DNSName: Match.anyValue() }),
    }));
    value.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    value.resourceCountIs("AWS::Route53::HostedZone", 0);
  });

  it("カスタムドメインがHosted Zone配下でなければ拒否する", () => {
    expect(() => template({ customDomainName: "workmate14.other.example" })).toThrow("must be a subdomain");
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

  it("アカウント・プロジェクト月額上限と台帳をRuntimeへ設定する", () => {
    const value = template({ cognitoDomainPrefix: "workmate14-budget-test", accountMonthlyBudgetUsd: "25.5", projectMonthlyBudgetUsd: "10" });
    value.hasResourceProperties("AWS::DynamoDB::Table", Match.objectLike({ BillingMode: "PAY_PER_REQUEST" }));
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      EnvironmentVariables: Match.objectLike({
        ACCOUNT_MONTHLY_BUDGET_NANO_USD: "25500000000",
        PROJECT_MONTHLY_BUDGET_NANO_USD: "10000000000",
        BUDGET_PROJECT_ID: "workmate-14",
        BUDGET_TABLE_NAME: Match.anyValue(),
        PRICING_TABLE_NAME: Match.anyValue(),
      }),
    }));
  });

  it("モデル価格を専用DynamoDBテーブルへ置き、Runtimeへ読み取りだけを許可する", () => {
    const value = template({ cognitoDomainPrefix: "workmate14-pricing-test" });
    value.hasResourceProperties("AWS::DynamoDB::Table", Match.objectLike({
      AttributeDefinitions: [{ AttributeName: "modelId", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "modelId", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    }));
    const policies = JSON.stringify(value.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("dynamodb:GetItem");
    expect(policies).toContain("ModelPricingCatalog");
  });

  it("公式Price Listと日次照合し、一致時だけ48時間の確認期限を延長する", () => {
    const value = template({ cognitoDomainPrefix: "workmate14-pricing-verifier-test" });
    value.hasResourceProperties("AWS::Lambda::Function", Match.objectLike({
      Handler: "index.lambda_handler",
      Runtime: "python3.13",
      Timeout: 120,
      Environment: { Variables: Match.objectLike({
        PRICING_TABLE_NAME: Match.anyValue(),
        PRICING_HISTORY_TABLE_NAME: Match.anyValue(),
        PRICE_VALIDITY_HOURS: "48",
      }) },
    }));
    value.hasResourceProperties("AWS::Events::Rule", Match.objectLike({
      ScheduleExpression: "cron(0 15 * * ? *)",
      State: "ENABLED",
    }));
    value.hasResourceProperties("AWS::DynamoDB::Table", Match.objectLike({
      AttributeDefinitions: [
        { AttributeName: "modelId", AttributeType: "S" },
        { AttributeName: "verificationId", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "modelId", KeyType: "HASH" },
        { AttributeName: "verificationId", KeyType: "RANGE" },
      ],
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    }));
    const templateJson = JSON.stringify(value.toJSON());
    expect(templateJson).toContain("dynamodb:TransactWriteItems");
    expect(templateJson).toContain("pricing:GetProducts");
    expect(templateJson).toContain("priceListInputUsageType");
    expect(templateJson).toContain("AmazonBedrockFoundationModels");
  });

  it("ユーザー上限プロファイルをCognitoグループとRuntimeへ設定する", () => {
    const profiles = [
      { id: "default", default: true, window: "monthly", tokenLimit: 1_000_000 },
      { id: "daily", default: false, window: "daily", tokenLimit: 50_000 },
    ];
    const value = template({ userLimitProfiles: JSON.stringify(profiles) });
    value.resourceCountIs("AWS::Cognito::UserPoolGroup", 2);
    value.hasResourceProperties("AWS::Cognito::UserPoolGroup", Match.objectLike({ GroupName: "workmate-limit-daily" }));
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      EnvironmentVariables: Match.objectLike({ USER_LIMIT_PROFILES_JSON: JSON.stringify(profiles) }),
    }));
  });

  it("デプロイスクリプト用Base64URLコンテキストを復号する", () => {
    const json = '[{"id":"default","default":true,"window":"monthly","tokenLimit":1000}]';
    const encoded = Buffer.from(json).toString("base64url");
    expect(decodeBase64UrlContext(encoded, "profiles")).toBe(json);
    expect(() => decodeBase64UrlContext(`${encoded}=`, "profiles")).toThrow("base64url");
  });

  it("既定ユーザー上限プロファイルが複数ならsynthを拒否する", () => {
    expect(() => template({ userLimitProfiles: JSON.stringify([
      { id: "one", default: true, window: "daily", tokenLimit: 1 },
      { id: "two", default: true, window: "weekly", tokenLimit: 2 },
    ]) })).toThrow("exactly one default");
  });

  it("8モデルへ推論権限を付け、未使用のCountTokens権限を付けない", () => {
    const policies = JSON.stringify(template().findResources("AWS::IAM::Policy"));
    expect(policies).toContain("claude-haiku-4-5");
    expect(policies).toContain("claude-sonnet-4-6");
    expect(policies).toContain("claude-sonnet-5");
    expect(policies).not.toContain("bedrock-mantle:CountTokens");
    expect(policies).not.toContain('"bedrock:CountTokens"');
    expect(policies).toContain("nova-2-lite");
    expect(policies).toContain("gpt-oss");
    expect(policies).toContain("glm-4.7");
  });

  it("不正な月額上限をsynth前に拒否する", () => {
    expect(() => resolveMonthlyBudgetNanoUsd("0", "100", "budget")).toThrow("greater than zero");
    expect(() => resolveMonthlyBudgetNanoUsd("1.0000000001", "100", "budget")).toThrow("must be a non-negative USD amount");
  });

  it("Runtime実行ロールへMemory暗号化キーの利用権限を付ける", () => {
    const value = template({ cognitoDomainPrefix: "workmate12-test" });
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

  it("既存Knowledge BaseだけをRuntimeへ接続する", () => {
    const value = template({ cognitoDomainPrefix: "workmate12-test" });
    value.hasParameter("KnowledgeBaseId", {
      Type: "String",
      AllowedPattern: "[0-9A-Z]{10}",
    });
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      EnvironmentVariables: Match.objectLike({ KNOWLEDGE_BASE_ID: { Ref: "KnowledgeBaseId" } }),
    }));
    const policies = value.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const retrieveStatements = statements.filter((statement) => statement.Action === "bedrock:Retrieve");
    expect(retrieveStatements).toHaveLength(1);
    expect(JSON.stringify(retrieveStatements[0].Resource)).toContain("knowledge-base/");
    expect(JSON.stringify(retrieveStatements[0].Resource)).toContain('"Ref":"KnowledgeBaseId"');
    expect(JSON.stringify(retrieveStatements[0].Resource)).not.toContain("knowledge-base/*");
  });

  it("Entraオプション有効時だけOIDC IdPを追加する", () => {
    const value = template({
      cognitoDomainPrefix: "workmate12-entra-test",
      entraEnabled: true,
      entraTenantId: "00000000-0000-0000-0000-000000000001",
      entraClientId: "00000000-0000-0000-0000-000000000002",
      entraClientSecretName: "workmate12/entra/client-secret",
    });
    value.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 1);
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
    expect(() => template({ cognitoDomainPrefix: "workmate12-test", loginMethods: "entra" }))
      .toThrow("requires entraEnabled=true");
  });

  it("未知のloginMethodsはsynthを拒否する", () => {
    expect(() => template({ cognitoDomainPrefix: "workmate12-test", loginMethods: "saml" }))
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
    const value = template({ cognitoDomainPrefix: "workmate12-test" });
    value.hasResourceProperties("AWS::Logs::LogGroup", Match.objectLike({ RetentionInDays: 3 }));
    value.resourceCountIs("AWS::Logs::Delivery", 2);
    const sources = value.findResources("AWS::Logs::DeliverySource");
    const logTypes = Object.values(sources).map((resource) => resource.Properties.LogType).sort();
    expect(logTypes).toEqual(["APPLICATION_LOGS", "USAGE_LOGS"]);
  });

  it("実行ロールへCloudWatch Logsの書き込み権限を付ける", () => {
    const value = template({ cognitoDomainPrefix: "workmate12-test" });
    value.hasResourceProperties("AWS::IAM::Policy", Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(["logs:CreateLogStream", "logs:PutLogEvents"]) }),
        ]),
      }),
    }));
  });

  it("logRetentionDaysで保持期間を変更できる", () => {
    template({ cognitoDomainPrefix: "workmate12-test", logRetentionDays: 30 })
      .hasResourceProperties("AWS::Logs::LogGroup", Match.objectLike({ RetentionInDays: 30 }));
  });

  it("CloudWatch Logsが受け付けない保持期間は拒否する", () => {
    expect(() => resolveLogRetention(4)).toThrow("logRetentionDays must be one of");
    expect(() => resolveLogRetention("abc")).toThrow("logRetentionDays must be one of");
    expect(resolveLogRetention(undefined)).toBe(RetentionDays.THREE_DAYS);
  });

  it("種別ごとのログをデプロイ時に無効化できる", () => {
    template({ cognitoDomainPrefix: "workmate12-test", runtimeLogModel: "off", runtimeLogTool: "off" })
      .hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
        EnvironmentVariables: Match.objectLike({ RUNTIME_LOG_MODEL: "off", RUNTIME_LOG_TOOL: "off" }),
      }));
  });

  it("未指定の種別は環境変数を設定せず既定の有効のままにする", () => {
    const runtimes = template({ cognitoDomainPrefix: "workmate12-test" }).findResources("AWS::BedrockAgentCore::Runtime");
    const environment = Object.values(runtimes)[0]?.Properties.EnvironmentVariables ?? {};
    expect(environment).not.toHaveProperty("RUNTIME_LOG_MODEL");
    expect(environment).not.toHaveProperty("RUNTIME_LOG_TOOL");
  });

  it("on/off以外の指定は拒否する", () => {
    expect(() => template({ cognitoDomainPrefix: "workmate12-test", runtimeLogModel: "maybe" })).toThrow("must be on or off");
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
