import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { decodeBase64UrlContext, WorkmateCostControlStack, resolveLogRetention, resolveMonthlyBudgetNanoUsd, resolveWebDebugMode } from "../infrastructure/stack.js";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

function template(context: Record<string, unknown> = {}) {
  const app = new App({ context: {
    customDomainEnabled: true,
    customDomainName: "cost-control.example.com",
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
    cognitoDomainPrefix: "cost-control-entra-test",
    entraEnabled: true,
    entraTenantId: "00000000-0000-0000-0000-000000000001",
    entraClientId: "00000000-0000-0000-0000-000000000002",
    entraClientSecretName: "cost-control/entra/client-secret",
  };
}

describe("WorkmateCostControlStack", () => {
  it("Cognito認証・静的Web・CodeZip Runtimeだけを構築する", () => {
    const value = template({ cognitoDomainPrefix: "cost-control-test" });
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
      Name: "workmate_cost_control_memory",
    });
  });

  it("既存証明書をCloudFrontへ設定し、既存Hosted ZoneへAlias Aレコードだけを追加する", () => {
    const value = template();
    value.hasResourceProperties("AWS::CloudFront::Distribution", Match.objectLike({
      DistributionConfig: Match.objectLike({
        Aliases: ["cost-control.example.com"],
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000003",
          MinimumProtocolVersion: "TLSv1.2_2021",
        }),
      }),
    }));
    value.hasResourceProperties("AWS::Route53::RecordSet", Match.objectLike({
      HostedZoneId: "Z1234567890ABC",
      Name: "cost-control.example.com.",
      Type: "A",
      AliasTarget: Match.objectLike({ DNSName: Match.anyValue() }),
    }));
    value.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    value.resourceCountIs("AWS::Route53::HostedZone", 0);
  });

  it("カスタムドメインがHosted Zone配下でなければ拒否する", () => {
    expect(() => template({ customDomainName: "cost-control.other.example" })).toThrow("must be a subdomain");
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
    const value = template({ cognitoDomainPrefix: "cost-control-budget-test", accountMonthlyBudgetUsd: "25.5", projectMonthlyBudgetUsd: "10" });
    value.hasResourceProperties("AWS::DynamoDB::Table", Match.objectLike({ BillingMode: "PAY_PER_REQUEST" }));
    value.hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
      EnvironmentVariables: Match.objectLike({
        ACCOUNT_MONTHLY_BUDGET_NANO_USD: "25500000000",
        PROJECT_MONTHLY_BUDGET_NANO_USD: "10000000000",
        BUDGET_PROJECT_ID: "cost-control",
        BUDGET_TABLE_NAME: Match.anyValue(),
      }),
    }));
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

  it("CountTokens対応モデルだけに推論権限を限定し、Sonnet 5はMantle計数だけを許可する", () => {
    const policies = JSON.stringify(template().findResources("AWS::IAM::Policy"));
    expect(policies).toContain("claude-haiku-4-5");
    expect(policies).toContain("claude-sonnet-4-6");
    expect(policies).toContain("claude-sonnet-5");
    expect(policies).toContain("bedrock-mantle:CountTokens");
    expect(policies).toContain("project/default");
    expect(policies).not.toContain("nova-2-lite");
    expect(policies).not.toContain("gpt-oss");
    expect(policies).not.toContain("glm-4.7");
  });

  it("不正な月額上限をsynth前に拒否する", () => {
    expect(() => resolveMonthlyBudgetNanoUsd("0", "100", "budget")).toThrow("greater than zero");
    expect(() => resolveMonthlyBudgetNanoUsd("1.0000000001", "100", "budget")).toThrow("must be a non-negative USD amount");
  });

  it("Runtime実行ロールへMemory暗号化キーの利用権限を付ける", () => {
    const value = template({ cognitoDomainPrefix: "cost-control-test" });
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
    const value = template({ cognitoDomainPrefix: "cost-control-test" });
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
      cognitoDomainPrefix: "cost-control-entra-test",
      entraEnabled: true,
      entraTenantId: "00000000-0000-0000-0000-000000000001",
      entraClientId: "00000000-0000-0000-0000-000000000002",
      entraClientSecretName: "cost-control/entra/client-secret",
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
    expect(() => template({ cognitoDomainPrefix: "cost-control-test", loginMethods: "entra" }))
      .toThrow("requires entraEnabled=true");
  });

  it("未知のloginMethodsはsynthを拒否する", () => {
    expect(() => template({ cognitoDomainPrefix: "cost-control-test", loginMethods: "saml" }))
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
    const value = template({ cognitoDomainPrefix: "cost-control-test" });
    value.hasResourceProperties("AWS::Logs::LogGroup", Match.objectLike({ RetentionInDays: 3 }));
    value.resourceCountIs("AWS::Logs::Delivery", 2);
    const sources = value.findResources("AWS::Logs::DeliverySource");
    const logTypes = Object.values(sources).map((resource) => resource.Properties.LogType).sort();
    expect(logTypes).toEqual(["APPLICATION_LOGS", "USAGE_LOGS"]);
  });

  it("実行ロールへCloudWatch Logsの書き込み権限を付ける", () => {
    const value = template({ cognitoDomainPrefix: "cost-control-test" });
    value.hasResourceProperties("AWS::IAM::Policy", Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(["logs:CreateLogStream", "logs:PutLogEvents"]) }),
        ]),
      }),
    }));
  });

  it("logRetentionDaysで保持期間を変更できる", () => {
    template({ cognitoDomainPrefix: "cost-control-test", logRetentionDays: 30 })
      .hasResourceProperties("AWS::Logs::LogGroup", Match.objectLike({ RetentionInDays: 30 }));
  });

  it("CloudWatch Logsが受け付けない保持期間は拒否する", () => {
    expect(() => resolveLogRetention(4)).toThrow("logRetentionDays must be one of");
    expect(() => resolveLogRetention("abc")).toThrow("logRetentionDays must be one of");
    expect(resolveLogRetention(undefined)).toBe(RetentionDays.THREE_DAYS);
  });

  it("種別ごとのログをデプロイ時に無効化できる", () => {
    template({ cognitoDomainPrefix: "cost-control-test", runtimeLogModel: "off", runtimeLogTool: "off" })
      .hasResourceProperties("AWS::BedrockAgentCore::Runtime", Match.objectLike({
        EnvironmentVariables: Match.objectLike({ RUNTIME_LOG_MODEL: "off", RUNTIME_LOG_TOOL: "off" }),
      }));
  });

  it("未指定の種別は環境変数を設定せず既定の有効のままにする", () => {
    const runtimes = template({ cognitoDomainPrefix: "cost-control-test" }).findResources("AWS::BedrockAgentCore::Runtime");
    const environment = Object.values(runtimes)[0]?.Properties.EnvironmentVariables ?? {};
    expect(environment).not.toHaveProperty("RUNTIME_LOG_MODEL");
    expect(environment).not.toHaveProperty("RUNTIME_LOG_TOOL");
  });

  it("on/off以外の指定は拒否する", () => {
    expect(() => template({ cognitoDomainPrefix: "cost-control-test", runtimeLogModel: "maybe" })).toThrow("must be on or off");
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
