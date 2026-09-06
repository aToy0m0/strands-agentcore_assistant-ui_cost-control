import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Fn, RemovalPolicy, SecretValue, Stack, Tags, type StackProps } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  CfnRuntime,
  Gateway,
  GatewayAuthorizer,
  GatewayProtocol,
  ManagedMemoryStrategy,
  MCPProtocolVersion,
  Memory,
  MemoryStrategyType,
  SchemaDefinitionType,
  ToolSchema,
} from "aws-cdk-lib/aws-bedrockagentcore";
import { AllowedMethods, CachePolicy, Distribution, PriceClass, SecurityPolicyProtocol, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { Alarm, ComparisonOperator, Dashboard, GraphWidget, SingleValueWidget, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { ARecord, HostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import {
  AccountRecovery,
  CfnUserPoolClient,
  CfnUserPoolIdentityProvider,
  OAuthScope,
  UserPool,
  UserPoolClientIdentityProvider,
} from "aws-cdk-lib/aws-cognito";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaTarget } from "aws-cdk-lib/aws-events-targets";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { FilterPattern, LogGroup, MetricFilter, RetentionDays } from "aws-cdk-lib/aws-logs";
import { LoggingDestination, LogType, configureLoggingDelivery } from "aws-cdk-lib/aws-bedrockagentcore";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import { COST_CONTROLLED_MODEL_CATALOG } from "../shared/model-catalog.js";
import { resolveLoginMethods, showsCognitoLogin, showsEntraLogin } from "../shared/login-methods.js";
import { MODEL_PRICING_CATALOG } from "../shared/initial-model-pricing.js";
import {
  assertKnowledgeBaseRegions,
  parseEnabledModelKeys,
  parseGatewayLambdaTargets,
  parseKnowledgeBases,
} from "../shared/deployment-resources.js";
import { cognitoDomainPrefix, resolveResourceNames, resolveRuntimeDisplayName } from "./naming.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const entraProviderName = "MicrosoftEntraID";

const gatewayToolCatalog = {
  "support-directory": {
    constructId: "SupportDirectory",
    functionNameSuffix: "support-directory-tool",
    description: "Read-only support contact lookup",
    assetDirectory: "gateway-tool",
    targetName: "SupportDirectory",
    targetDescription: "Looks up the contact address and business hours for a support department",
    toolSchema: () => ToolSchema.fromInline([{
      name: "lookup_support_contact",
      description: "Look up the email address and business hours for sales, support, or billing.",
      inputSchema: {
        type: SchemaDefinitionType.OBJECT,
        properties: {
          department: {
            type: SchemaDefinitionType.STRING,
            description: "Department name: sales, support, or billing.",
          },
        },
        required: ["department"],
      },
      outputSchema: {
        type: SchemaDefinitionType.OBJECT,
        properties: {
          department: { type: SchemaDefinitionType.STRING },
          email: { type: SchemaDefinitionType.STRING },
          hours: { type: SchemaDefinitionType.STRING },
        },
        required: ["department", "email", "hours"],
      },
    }]),
  },
} as const;

/** CloudWatch Logsが受け付ける保持日数。ここにない値はCloudFormationが拒否する。 */
const RETENTION_BY_DAYS = new Map<number, RetentionDays>(
  Object.entries(RetentionDays)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([, days]) => [days, days as RetentionDays]),
);

export function resolveLogRetention(configured: unknown): RetentionDays {
  if (configured === undefined || configured === null) return RetentionDays.THREE_DAYS;
  const days = typeof configured === "number" ? configured : Number(configured);
  const retention = Number.isInteger(days) ? RETENTION_BY_DAYS.get(days) : undefined;
  if (retention === undefined) {
    throw new Error(`logRetentionDays must be one of: ${[...RETENTION_BY_DAYS.keys()].sort((a, b) => a - b).join(", ")}`);
  }
  return retention;
}

/** 種別ごとのログをデプロイ時に無効化できるようにする。既定は有効。 */
export function runtimeLogSettings(scope: Construct): Record<string, string> {
  const categories = { request: "RUNTIME_LOG_REQUEST", model: "RUNTIME_LOG_MODEL", tool: "RUNTIME_LOG_TOOL" } as const;
  const settings: Record<string, string> = {};
  for (const [category, variable] of Object.entries(categories)) {
    const configured = scope.node.tryGetContext(`runtimeLog${category.charAt(0).toUpperCase()}${category.slice(1)}`);
    if (configured === undefined) continue;
    const value = String(configured).trim().toLowerCase();
    if (!["on", "off", "true", "false"].includes(value)) {
      throw new Error(`runtimeLog${category.charAt(0).toUpperCase()}${category.slice(1)} must be on or off`);
    }
    settings[variable] = value === "on" || value === "true" ? "on" : "off";
  }
  return settings;
}

export function resolveWebDebugMode(configured: unknown): boolean {
  if (configured === undefined || configured === null) return false;
  const value = String(configured).trim().toLowerCase();
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new Error("webDebugMode must be on or off");
}

const NANO_USD_PER_USD = 1_000_000_000n;

export function resolveMonthlyBudgetNanoUsd(configured: unknown, defaultUsd: string, name: string): string {
  const value = configured === undefined || configured === null ? defaultUsd : String(configured).trim();
  if (!/^\d+(\.\d{1,9})?$/.test(value)) throw new Error(`${name} must be a non-negative USD amount with at most 9 decimal places`);
  const [whole, fraction = ""] = value.split(".");
  const nanoUsd = BigInt(whole!) * NANO_USD_PER_USD + BigInt(fraction.padEnd(9, "0"));
  if (nanoUsd <= 0n) throw new Error(`${name} must be greater than zero`);
  return nanoUsd.toString();
}

export function decodeBase64UrlContext(configured: unknown, name: string): string | undefined {
  if (configured === undefined || configured === null) return undefined;
  if (typeof configured !== "string" || !/^[A-Za-z0-9_-]+$/u.test(configured)) throw new Error(`${name} must be base64url`);
  const decoded = Buffer.from(configured, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== configured) throw new Error(`${name} must be canonical base64url`);
  return decoded;
}

function contextString(scope: Construct, name: string): string {
  const value = scope.node.tryGetContext(name);
  if (typeof value !== "string" || !value.trim()) throw new Error(`CDK context ${name} is required`);
  return value.trim();
}

export class AgentCoreCostControlStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const entraEnabledValue = this.node.tryGetContext("entraEnabled");
    const entraEnabled = entraEnabledValue === true || entraEnabledValue === "true";
    const loginMethods = resolveLoginMethods(this.node.tryGetContext("loginMethods"), entraEnabled);
    const names = resolveResourceNames(this.node.tryGetContext("defaultCdkPrefix"));
    const runtimeDisplayName = resolveRuntimeDisplayName(this.node.tryGetContext("runtimeDisplayName"));
    Tags.of(this).add("Application", names.base);
    Tags.of(this).add("CostGroup", names.base);
    const domainPrefix = cognitoDomainPrefix(names);
    const logRetention = resolveLogRetention(this.node.tryGetContext("logRetentionDays"));
    const runtimeLogEnvironment = runtimeLogSettings(this);
    const webDebugMode = resolveWebDebugMode(this.node.tryGetContext("webDebugMode"));
    const monthlyBudgetNanoUsd = resolveMonthlyBudgetNanoUsd(this.node.tryGetContext("monthlyBudgetUsd"), "60", "monthlyBudgetUsd");
    const budgetScopeId = names.base;
    const priceVerificationEnabledValue = this.node.tryGetContext("priceVerificationEnabled");
    if (priceVerificationEnabledValue !== undefined && ![true, false, "true", "false"].includes(priceVerificationEnabledValue)) {
      throw new Error("priceVerificationEnabled must be true or false");
    }
    const priceVerificationEnabled = priceVerificationEnabledValue === true || priceVerificationEnabledValue === "true";
    const encodedKnowledgeBases = decodeBase64UrlContext(this.node.tryGetContext("knowledgeBasesBase64"), "knowledgeBasesBase64");
    const knowledgeBases = parseKnowledgeBases(encodedKnowledgeBases ?? this.node.tryGetContext("knowledgeBases"));
    const knowledgeBasesJson = JSON.stringify(knowledgeBases);
    const allowCrossRegionKnowledgeBases = this.node.tryGetContext("allowCrossRegionKnowledgeBases") === true
      || this.node.tryGetContext("allowCrossRegionKnowledgeBases") === "true";
    assertKnowledgeBaseRegions(knowledgeBases, this.region, allowCrossRegionKnowledgeBases);
    const encodedGatewayTargets = decodeBase64UrlContext(this.node.tryGetContext("gatewayTargetsBase64"), "gatewayTargetsBase64");
    const gatewayTargets = parseGatewayLambdaTargets(encodedGatewayTargets ?? this.node.tryGetContext("gatewayTargets"));
    const encodedEnabledModelKeys = decodeBase64UrlContext(this.node.tryGetContext("enabledModelKeysBase64"), "enabledModelKeysBase64");
    const enabledModelKeys = parseEnabledModelKeys(
      encodedEnabledModelKeys ?? this.node.tryGetContext("enabledModelKeys"),
      COST_CONTROLLED_MODEL_CATALOG.map((model) => model.key),
    );
    const geminiEnabledValue = this.node.tryGetContext("geminiEnabled");
    const geminiEnabled = geminiEnabledValue === true || geminiEnabledValue === "true";
    const geminiApiKeySecretName = geminiEnabled ? contextString(this, "geminiApiKeySecretName") : undefined;
    if (enabledModelKeys.includes("gemini-3-5-flash") && !geminiEnabled) {
      throw new Error("enabledModelKeys includes gemini-3-5-flash but geminiEnabled is false");
    }
    const customDomainEnabledValue = this.node.tryGetContext("customDomainEnabled");
    const customDomainEnabled = customDomainEnabledValue === true || customDomainEnabledValue === "true";
    let customDomainName: string | undefined;
    let hostedZone: ReturnType<typeof HostedZone.fromHostedZoneAttributes> | undefined;
    let certificate: ReturnType<typeof Certificate.fromCertificateArn> | undefined;
    if (customDomainEnabled) {
      customDomainName = contextString(this, "customDomainName").toLowerCase();
      const hostedZoneId = contextString(this, "hostedZoneId");
      const hostedZoneName = contextString(this, "hostedZoneName").replace(/\.$/u, "").toLowerCase();
      const certificateArn = contextString(this, "certificateArn");
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(customDomainName)) throw new Error("customDomainName must be a valid lowercase DNS name");
      if (!/^Z[A-Z0-9]+$/u.test(hostedZoneId)) throw new Error("hostedZoneId must be a Route 53 hosted zone ID");
      if (customDomainName === hostedZoneName || !customDomainName.endsWith(`.${hostedZoneName}`)) {
        throw new Error("customDomainName must be a subdomain of hostedZoneName");
      }
      if (!/^arn:[^:]+:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]+$/u.test(certificateArn)) {
        throw new Error("certificateArn must be an ACM certificate ARN in us-east-1 for CloudFront");
      }
      // Hosted ZoneとACM証明書は既存リソースを参照するだけで、CloudFormationの管理対象にしない。
      hostedZone = HostedZone.fromHostedZoneAttributes(this, "ExistingHostedZone", { hostedZoneId, zoneName: hostedZoneName });
      certificate = Certificate.fromCertificateArn(this, "ExistingCertificate", certificateArn);
    }
    const webBucket = new Bucket(this, "WebAssets", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const distribution = new Distribution(this, "Distribution", {
      ...(customDomainEnabled ? {
        domainNames: [customDomainName!],
        certificate: certificate!,
        minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      } : {}),
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(webBucket),
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      additionalBehaviors: {
        "runtime-config.json": {
          origin: S3BucketOrigin.withOriginAccessControl(webBucket),
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.seconds(0) },
      ],
      priceClass: PriceClass.PRICE_CLASS_100,
    });
    const applicationUrl = customDomainEnabled ? `https://${customDomainName}` : `https://${distribution.distributionDomainName}`;
    if (customDomainEnabled) {
      new ARecord(this, "ApplicationAliasRecord", {
        zone: hostedZone!,
        recordName: customDomainName!,
        target: RecordTarget.fromAlias(new CloudFrontTarget(distribution)),
      });
    }

    const userPool = new UserPool(this, "UserPool", {
      userPoolName: names.userPoolName,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true }, fullname: { required: false, mutable: true } },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true, tempPasswordValidity: Duration.days(7) },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const userPoolDomain = userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix },
    });
    let entraProvider: CfnUserPoolIdentityProvider | undefined;
    if (entraEnabled) {
      const tenantId = contextString(this, "entraTenantId");
      const clientId = contextString(this, "entraClientId");
      const clientSecretName = contextString(this, "entraClientSecretName");
      entraProvider = new CfnUserPoolIdentityProvider(this, "EntraIdentityProvider", {
        userPoolId: userPool.userPoolId,
        providerName: entraProviderName,
        providerType: "OIDC",
        providerDetails: {
          attributes_request_method: "GET",
          authorize_scopes: "openid email",
          client_id: clientId,
          client_secret: SecretValue.secretsManager(clientSecretName).unsafeUnwrap(),
          oidc_issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        },
        attributeMapping: { email: "email", username: "sub" },
      });
    }

    // 画面に出さない認証手段はApp Client側でも塞ぐ。UIを迂回した直接のInitiateAuthやHosted UIも拒否させる。
    const allowsCognitoSignIn = showsCognitoLogin(loginMethods);
    const allowsEntraSignIn = entraEnabled && showsEntraLogin(loginMethods);
    const supportedIdentityProviders = [];
    if (allowsCognitoSignIn) supportedIdentityProviders.push(UserPoolClientIdentityProvider.COGNITO);
    if (allowsEntraSignIn) supportedIdentityProviders.push(UserPoolClientIdentityProvider.custom(entraProviderName));
    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: names.userPoolClientName,
      generateSecret: false,
      // userPasswordは総当たりに使いやすいため、Cognitoログインを見せる場合もSRPだけに限定する。
      authFlows: allowsCognitoSignIn ? { userSrp: true } : {},
      supportedIdentityProviders,
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: [`${applicationUrl}/`, "http://localhost:5173/"],
        logoutUrls: [`${applicationUrl}/`, "http://localhost:5173/"],
      },
    });
    if (entraProvider) userPoolClient.node.addDependency(entraProvider);
    if (!allowsCognitoSignIn) {
      // authFlowsを空にするとExplicitAuthFlowsがテンプレートから消え、Cognitoの既定（SRPを含む）が適用される。
      // それではUIを迂回したInitiateAuthを塞げないため、更新に必要な最小の1つだけを明示する。
      const cfnUserPoolClient = userPoolClient.node.defaultChild as CfnUserPoolClient;
      cfnUserPoolClient.explicitAuthFlows = ["ALLOW_REFRESH_TOKEN_AUTH"];
    }

    const artifactBucket = new Bucket(this, "RuntimeArtifacts", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const runtimeKeyPrefix = "runtime";
    const runtimeUpload = new BucketDeployment(this, "RuntimeUpload", {
      destinationBucket: artifactBucket,
      destinationKeyPrefix: runtimeKeyPrefix,
      sources: [Source.asset(path.join(root, "..", "runtime", "deployment_package.zip"))],
      extract: false,
      prune: true,
      logRetention,
    });
    const runtimeObjectKey = Fn.join("/", [runtimeKeyPrefix, Fn.select(0, runtimeUpload.objectKeys)]);
    const runtimeRole = new Role(this, "RuntimeRole", { assumedBy: new ServicePrincipal("bedrock-agentcore.amazonaws.com") });
    const geminiApiKeySecret = geminiEnabled
      ? Secret.fromSecretNameV2(this, "GeminiApiKeySecret", geminiApiKeySecretName!)
      : undefined;
    geminiApiKeySecret?.grantRead(runtimeRole);
    const budgetTable = new Table(this, "BudgetLedger", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });
    budgetTable.grantReadWriteData(runtimeRole);
    const budgetConfiguration = new AwsCustomResource(this, "BudgetConfiguration", {
      installLatestAwsSdk: false,
      logRetention,
      onCreate: {
        service: "DynamoDB",
        action: "putItem",
        parameters: {
          TableName: budgetTable.tableName,
          Item: {
            PK: { S: `APP#${budgetScopeId}` },
            SK: { S: "CONFIG" },
            limitNanoUsd: { N: monthlyBudgetNanoUsd },
          },
        },
        physicalResourceId: PhysicalResourceId.of(`budget-configuration-${budgetScopeId}`),
      },
      onUpdate: {
        service: "DynamoDB",
        action: "putItem",
        parameters: {
          TableName: budgetTable.tableName,
          Item: {
            PK: { S: `APP#${budgetScopeId}` },
            SK: { S: "CONFIG" },
            limitNanoUsd: { N: monthlyBudgetNanoUsd },
          },
        },
        physicalResourceId: PhysicalResourceId.of(`budget-configuration-${budgetScopeId}`),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [budgetTable.tableArn] }),
    });
    budgetConfiguration.node.addDependency(budgetTable);

    const pricingCatalogBucket = new Bucket(this, "PricingCatalogBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const pricingCatalogObjectKey = "catalog/model-pricing.json";
    const pricingCatalogDeployment = new BucketDeployment(this, "PricingCatalogDeployment", {
      destinationBucket: pricingCatalogBucket,
      destinationKeyPrefix: "catalog",
      sources: [Source.jsonData("model-pricing.json", MODEL_PRICING_CATALOG)],
      prune: true,
      logRetention,
    });
    pricingCatalogBucket.grantRead(runtimeRole);
    let pricingVerifier: LambdaFunction | undefined;
    if (priceVerificationEnabled) {
      const pricingVerifierLogGroup = new LogGroup(this, "PricingVerifierLogs", {
        logGroupName: names.pricingVerifierLogGroupName,
        retention: logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const pricingWarningMetric = new MetricFilter(this, "PricingVerificationWarningMetric", {
        logGroup: pricingVerifierLogGroup,
        filterPattern: FilterPattern.stringValue("$.event", "=", "pricing.verification.warning"),
        metricNamespace: names.metricNamespace,
        metricName: "PricingVerificationWarnings",
        metricValue: "1",
        defaultValue: 0,
      });
      new Alarm(this, "PricingVerificationWarningAlarm", {
        alarmDescription: "Model pricing verification reported a mismatch or unavailable source; inference continues with configured prices",
        metric: pricingWarningMetric.metric({ period: Duration.minutes(5), statistic: "Sum" }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      pricingVerifier = new LambdaFunction(this, "PricingVerifier", {
        description: "Compares the approved model price catalog with the official AWS Price List API",
        runtime: Runtime.PYTHON_3_13,
        handler: "index.lambda_handler",
        code: Code.fromAsset(path.join(root, "..", "pricing-verifier"), { exclude: ["test_*.py", "__pycache__"] }),
        timeout: Duration.minutes(2),
        memorySize: 256,
        logGroup: pricingVerifierLogGroup,
        environment: {
          PRICING_CATALOG_BUCKET_NAME: pricingCatalogBucket.bucketName,
          PRICING_CATALOG_OBJECT_KEY: pricingCatalogObjectKey,
        },
      });
      pricingCatalogBucket.grantRead(pricingVerifier);
      pricingVerifier.addToRolePolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["pricing:GetProducts"], resources: ["*"] }));
      const pricingVerificationSchedule = new Rule(this, "PricingVerificationSchedule", {
        description: "Checks approved model prices daily at 00:00 JST (15:00 UTC)",
        schedule: Schedule.cron({ minute: "0", hour: "15" }),
      });
      pricingVerificationSchedule.addTarget(new LambdaTarget(pricingVerifier, { retryAttempts: 2 }));
      pricingVerifier.node.addDependency(pricingCatalogDeployment);
    }
    const gatewayRole = new Role(this, "ToolGatewayRole", {
      description: `Least-privilege execution role for the ${names.base} AgentCore Gateway`,
      assumedBy: new ServicePrincipal("bedrock-agentcore.amazonaws.com").withConditions({
        StringEquals: { "aws:SourceAccount": this.account },
        ArnLike: { "aws:SourceArn": `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:gateway/${names.gatewayName}*` },
      }),
    });
    const toolGateway = new Gateway(this, "ToolGateway", {
      gatewayName: names.gatewayName,
      description: `${runtimeDisplayName} MCP gateway for authenticated Lambda tools`,
      authorizerConfiguration: GatewayAuthorizer.usingCognito({
        userPool,
        allowedClients: [userPoolClient],
      }),
      protocolConfiguration: GatewayProtocol.mcp({
        supportedVersions: [MCPProtocolVersion.of("2025-11-25")],
        instructions: `Use the available read-only ${runtimeDisplayName} business tools when their descriptions match the user request.`,
      }),
      role: gatewayRole,
    });
    const configuredGatewayTargets = gatewayTargets.filter((target) => target.enabled).map((target) => {
      if (!(target.key in gatewayToolCatalog)) throw new Error(`gatewayTargets references unknown catalog key '${target.key}'`);
      const catalog = gatewayToolCatalog[target.key as keyof typeof gatewayToolCatalog];
      const isLegacySupportDirectory = target.key === "support-directory";
      const gatewayToolLogGroup = new LogGroup(this, isLegacySupportDirectory ? "GatewayToolLogs" : `${catalog.constructId}Logs`, {
        logGroupName: names.gatewayToolLogGroupName(target.key),
        retention: logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const gatewayTool = new LambdaFunction(this, isLegacySupportDirectory ? "GatewayTool" : `${catalog.constructId}Function`, {
        functionName: names.gatewayToolFunctionName(catalog.functionNameSuffix),
        description: `${catalog.description} for the ${runtimeDisplayName} AgentCore Gateway`,
        runtime: Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: Code.fromAsset(path.join(root, "..", catalog.assetDirectory), { exclude: ["*.node-test.mjs"] }),
        timeout: Duration.seconds(target.timeoutSeconds),
        memorySize: target.memorySizeMb,
        environment: target.environmentVariables,
        logGroup: gatewayToolLogGroup,
      });
      const gatewayTarget = toolGateway.addLambdaTarget(`${catalog.constructId}Target`, {
        gatewayTargetName: catalog.targetName,
        description: catalog.targetDescription,
        lambdaFunction: gatewayTool,
        toolSchema: catalog.toolSchema(),
      });
      return { key: target.key, target: gatewayTarget };
    });
    const memoryKey = new Key(this, "MemoryKey", {
      alias: names.kmsMemoryAlias,
      description: `Encrypts ${runtimeDisplayName} AgentCore Memory`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const memory = new Memory(this, "ChatMemory", {
      memoryName: names.memoryName,
      description: "User-scoped chat history and personal long-term memory",
      expirationDuration: Duration.days(30),
      kmsKey: memoryKey,
      memoryStrategies: [
        new ManagedMemoryStrategy(MemoryStrategyType.SEMANTIC, {
          strategyName: "PersonalFacts",
          description: "Extract durable user facts across chat sessions",
          namespaces: [`${names.memoryNamespacePrefix}/{actorId}/facts`],
        }),
        new ManagedMemoryStrategy(MemoryStrategyType.USER_PREFERENCE, {
          strategyName: "UserPreferences",
          description: "Extract durable user preferences across chat sessions",
          namespaces: [`${names.memoryNamespacePrefix}/{actorId}/preferences`],
        }),
      ],
    });
    memory.grantWrite(runtimeRole);
    memory.grantReadShortTermMemory(runtimeRole);
    memory.grantReadLongTermMemory(runtimeRole);
    memory.grantDeleteShortTermMemory(runtimeRole);
    memoryKey.grantEncryptDecrypt(runtimeRole);
    runtimeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["kms:DescribeKey"],
      resources: [memoryKey.keyArn],
    }));
    const bedrockModels = COST_CONTROLLED_MODEL_CATALOG.filter((model) => model.provider !== "google" && enabledModelKeys.includes(model.key));
    const bedrockResources = (models: readonly (typeof bedrockModels)[number][]) => models.flatMap((model) => [
      ...(model.modelId.startsWith("us.") ? [
        `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${model.modelId}`,
        ...["us-east-1", "us-east-2", "us-west-2"].flatMap((region) => model.foundationModelIds.map((foundationModelId) => `arn:${this.partition}:bedrock:${region}::foundation-model/${foundationModelId}`)),
      ] : model.foundationModelIds.map((foundationModelId) => `arn:${this.partition}:bedrock:${this.region}::foundation-model/${foundationModelId}`)),
      ...("requiresDefaultProject" in model && model.requiresDefaultProject ? [`arn:${this.partition}:bedrock:${this.region}:${this.account}:project/default`] : []),
    ]);
    if (bedrockModels.length > 0) {
      runtimeRole.addToPolicy(new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:CountTokens"],
        resources: bedrockResources(bedrockModels),
      }));
    }
    const knowledgeBaseResources = knowledgeBases
      .filter((knowledgeBase) => knowledgeBase.enabled)
      .map((knowledgeBase) => `arn:${this.partition}:bedrock:${knowledgeBase.region}:${this.account}:knowledge-base/${knowledgeBase.knowledgeBaseId}`);
    if (knowledgeBaseResources.length > 0) {
      runtimeRole.addToPolicy(new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock:Retrieve"],
        resources: knowledgeBaseResources,
      }));
    }
    // AgentCore Runtimeが自身のロググループへ書けるようにする。これがないとログが1行も残らない。
    runtimeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["logs:CreateLogGroup", "logs:DescribeLogGroups"],
      resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`],
    }));
    runtimeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["logs:DescribeLogStreams", "logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
    }));
    artifactBucket.grantRead(runtimeRole);
    const agentRuntime = new CfnRuntime(this, "AgentRuntime", {
      agentRuntimeName: names.runtimeName,
      description: `${runtimeDisplayName} browser-direct AG-UI CodeZip runtime with LLM budget control`,
      agentRuntimeArtifact: { codeConfiguration: { code: { s3: { bucket: artifactBucket.bucketName, prefix: runtimeObjectKey } }, runtime: "NODE_22", entryPoint: ["dist/app.js"] } },
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`,
          allowedClients: [userPoolClient.userPoolClientId],
        },
      },
      requestHeaderConfiguration: { requestHeaderAllowlist: ["Authorization"] },
      roleArn: runtimeRole.roleArn,
      networkConfiguration: { networkMode: "PUBLIC" },
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 1800 },
      protocolConfiguration: "AGUI",
      environmentVariables: {
        AWS_REGION: this.region,
        GATEWAY_URL: toolGateway.gatewayUrl!,
        KNOWLEDGE_BASES_JSON: knowledgeBasesJson,
        MEMORY_ID: memory.memoryId,
        BUDGET_TABLE_NAME: budgetTable.tableName,
        BUDGET_SCOPE_ID: budgetScopeId,
        APPLICATION_NAME: names.applicationName,
        MEMORY_NAMESPACE_PREFIX: names.memoryNamespacePrefix,
        PRICING_CATALOG_BUCKET_NAME: pricingCatalogBucket.bucketName,
        PRICING_CATALOG_OBJECT_KEY: pricingCatalogObjectKey,
        ENABLED_MODEL_KEYS_JSON: JSON.stringify(enabledModelKeys),
        ...(geminiApiKeySecretName ? { GEMINI_API_KEY_SECRET_NAME: geminiApiKeySecretName } : {}),
        ...runtimeLogEnvironment,
      },
    });
    agentRuntime.node.addDependency(runtimeUpload);
    agentRuntime.node.addDependency(budgetConfiguration, pricingCatalogDeployment);

    // AgentCoreが初回起動時に利用する既定ロググループもCDK管理下に置き、保持期間なしの残存を防ぐ。
    const agentCoreRuntimeServiceLogGroup = new LogGroup(this, "AgentCoreRuntimeServiceLogs", {
      logGroupName: Fn.join("", ["/aws/bedrock-agentcore/runtimes/", agentRuntime.attrAgentRuntimeId, "-DEFAULT"]),
      retention: logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    agentCoreRuntimeServiceLogGroup.node.addDependency(agentRuntime);

    // 保持期間を制御するため、サービス任せにせずこちらでロググループを持つ。
    const runtimeLogGroup = new LogGroup(this, "RuntimeLogs", {
      logGroupName: names.runtimeLogGroupName,
      retention: logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const settledCostFilter = new MetricFilter(this, "RecordedModelCostMetric", {
      logGroup: runtimeLogGroup,
      filterPattern: FilterPattern.literal('{ $.event = "model.cost.recorded" && $.actualUsd = * }'),
      metricNamespace: names.metricNamespace,
      metricName: "SettledModelCostUsd",
      metricValue: "$.actualUsd",
      defaultValue: 0,
    });
    const settledTokensFilter = new MetricFilter(this, "RecordedModelTokensMetric", {
      logGroup: runtimeLogGroup,
      filterPattern: FilterPattern.literal('{ $.event = "model.cost.recorded" && $.actualTokens = * }'),
      metricNamespace: names.metricNamespace,
      metricName: "SettledModelTokens",
      metricValue: "$.actualTokens",
      defaultValue: 0,
    });
    const costDashboard = new Dashboard(this, "CostDashboard", {
      dashboardName: names.dashboardName,
    });
    const costMetric = settledCostFilter.metric({ statistic: "Sum", period: Duration.hours(1) });
    const tokenMetric = settledTokensFilter.metric({ statistic: "Sum", period: Duration.hours(1) });
    costDashboard.addWidgets(
      new SingleValueWidget({ title: "Model cost (selected period, USD)", metrics: [costMetric], setPeriodToTimeRange: true }),
      new SingleValueWidget({ title: "Model tokens (selected period)", metrics: [tokenMetric], setPeriodToTimeRange: true }),
      new GraphWidget({ title: "Hourly model cost (USD)", left: [costMetric] }),
      new GraphWidget({ title: "Hourly model tokens", left: [tokenMetric] }),
    );
    configureLoggingDelivery(this, agentRuntime.attrAgentRuntimeArn, [
      { logType: LogType.APPLICATION_LOGS, destination: LoggingDestination.cloudWatchLogs(runtimeLogGroup) },
      { logType: LogType.USAGE_LOGS, destination: LoggingDestination.cloudWatchLogs(runtimeLogGroup) },
    ]);

    const webDeployment = new BucketDeployment(this, "WebDeployment", {
      destinationBucket: webBucket,
      sources: [
        Source.asset(path.join(root, "..", "dist")),
        Source.jsonData("runtime-config.json", {
          environment: "production",
          debug: webDebugMode,
          auth: {
            region: this.region,
            userPoolId: userPool.userPoolId,
            userPoolClientId: userPoolClient.userPoolClientId,
            cognitoDomain: `${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
            entraEnabled,
            entraProviderName: entraEnabled ? entraProviderName : null,
            loginMethods,
          },
          ui: { name: runtimeDisplayName },
          agent: { runtimeArn: agentRuntime.attrAgentRuntimeArn, qualifier: "DEFAULT" },
          features: { enabledModelKeys },
        }),
      ],
      logRetention,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
    });
    webDeployment.node.addDependency(agentRuntime);

    new CfnOutput(this, "ApplicationUrl", { value: applicationUrl });
    new CfnOutput(this, "DefaultCdkPrefix", { value: names.base });
    new CfnOutput(this, "RuntimeDisplayName", { value: runtimeDisplayName });
    new CfnOutput(this, "CloudFrontDomainName", { value: distribution.distributionDomainName });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "CognitoDomain", { value: `${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com` });
    if (entraEnabled) {
      new CfnOutput(this, "EntraRedirectUri", { value: `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com/oauth2/idpresponse` });
    }
    new CfnOutput(this, "AgentRuntimeArn", { value: agentRuntime.attrAgentRuntimeArn });
    new CfnOutput(this, "MemoryId", { value: memory.memoryId });
    new CfnOutput(this, "ToolGatewayUrl", { value: toolGateway.gatewayUrl! });
    for (const configuredTarget of configuredGatewayTargets) {
      new CfnOutput(this, `${gatewayToolCatalog[configuredTarget.key as keyof typeof gatewayToolCatalog].constructId}TargetId`, {
        value: configuredTarget.target.targetId,
      });
    }
    new CfnOutput(this, "RuntimeArtifactsBucketName", { value: artifactBucket.bucketName });
    new CfnOutput(this, "RuntimeLogGroupName", { value: runtimeLogGroup.logGroupName });
    new CfnOutput(this, "BudgetLedgerTableName", { value: budgetTable.tableName });
    new CfnOutput(this, "BudgetScopeId", { value: budgetScopeId });
    new CfnOutput(this, "ModelPricingCatalogBucketName", { value: pricingCatalogBucket.bucketName });
    if (pricingVerifier) new CfnOutput(this, "PricingVerifierFunctionName", { value: pricingVerifier.functionName });
    new CfnOutput(this, "CostDashboardName", { value: costDashboard.dashboardName });
    new CfnOutput(this, "MonthlyBudgetUsd", { value: this.node.tryGetContext("monthlyBudgetUsd")?.toString() ?? "60" });
  }
}
