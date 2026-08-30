import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
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
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { ARecord, HostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import {
  AccountRecovery,
  CfnUserPoolGroup,
  CfnUserPoolClient,
  CfnUserPoolIdentityProvider,
  OAuthScope,
  UserPool,
  UserPoolClientIdentityProvider,
} from "aws-cdk-lib/aws-cognito";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { LoggingDestination, LogType, configureLoggingDelivery } from "aws-cdk-lib/aws-bedrockagentcore";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import { COST_CONTROLLED_MODEL_CATALOG } from "../shared/model-catalog.js";
import { resolveLoginMethods, showsCognitoLogin, showsEntraLogin } from "../shared/login-methods.js";
import { defaultUserLimitProfile, parseUserLimitProfiles } from "../shared/user-limit-profiles.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const entraProviderName = "MicrosoftEntraID";

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

export class WorkmateCostControlStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const entraEnabledValue = this.node.tryGetContext("entraEnabled");
    const entraEnabled = entraEnabledValue === true || entraEnabledValue === "true";
    const loginMethods = resolveLoginMethods(this.node.tryGetContext("loginMethods"), entraEnabled);
    const configuredDomainPrefix = this.node.tryGetContext("cognitoDomainPrefix");
    if (configuredDomainPrefix !== undefined && (typeof configuredDomainPrefix !== "string" || !/^[a-z0-9-]{1,63}$/.test(configuredDomainPrefix))) {
      throw new Error("cognitoDomainPrefix must contain only lowercase letters, numbers, and hyphens");
    }
    const domainPrefix = typeof configuredDomainPrefix === "string" ? configuredDomainPrefix : `cost-control-${this.account}`;
    const logRetention = resolveLogRetention(this.node.tryGetContext("logRetentionDays"));
    const runtimeLogEnvironment = runtimeLogSettings(this);
    const webDebugMode = resolveWebDebugMode(this.node.tryGetContext("webDebugMode"));
    const accountBudgetNanoUsd = resolveMonthlyBudgetNanoUsd(this.node.tryGetContext("accountMonthlyBudgetUsd"), "100", "accountMonthlyBudgetUsd");
    const projectBudgetNanoUsd = resolveMonthlyBudgetNanoUsd(this.node.tryGetContext("projectMonthlyBudgetUsd"), "60", "projectMonthlyBudgetUsd");
    const encodedUserLimitProfiles = decodeBase64UrlContext(this.node.tryGetContext("userLimitProfilesBase64"), "userLimitProfilesBase64");
    const userLimitProfiles = parseUserLimitProfiles(encodedUserLimitProfiles ?? this.node.tryGetContext("userLimitProfiles"));
    const userLimitProfilesJson = JSON.stringify(userLimitProfiles);
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
    const knowledgeBaseId = new CfnParameter(this, "KnowledgeBaseId", {
      type: "String",
      allowedPattern: "[0-9A-Z]{10}",
      constraintDescription: "must be a 10-character uppercase alphanumeric Bedrock Knowledge Base ID",
      description: "Existing Bedrock Knowledge Base used by the runtime search tool",
    });

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
      userPoolName: "workmate-cost-control-users",
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
    for (const profile of userLimitProfiles) {
      new CfnUserPoolGroup(this, `UserLimitGroup${profile.id.replace(/(^|-)([a-z0-9])/gu, (_match, _separator, character: string) => character.toUpperCase())}`, {
        userPoolId: userPool.userPoolId,
        groupName: `workmate-limit-${profile.id}`,
        description: `${profile.window} token limit: ${profile.tokenLimit}`,
      });
    }

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
      userPoolClientName: "workmate-cost-control-web",
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
    });
    const runtimeObjectKey = Fn.join("/", [runtimeKeyPrefix, Fn.select(0, runtimeUpload.objectKeys)]);
    const runtimeRole = new Role(this, "RuntimeRole", { assumedBy: new ServicePrincipal("bedrock-agentcore.amazonaws.com") });
    const budgetTable = new Table(this, "BudgetLedger", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    budgetTable.grantReadWriteData(runtimeRole);
    const gatewayToolLogGroup = new LogGroup(this, "GatewayToolLogs", {
      retention: logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const gatewayTool = new LambdaFunction(this, "GatewayTool", {
      functionName: "cost-control-support-directory-tool",
      description: "Read-only support contact lookup for the Workmate AgentCore Gateway",
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset(path.join(root, "..", "gateway-tool"), { exclude: ["*.node-test.mjs"] }),
      timeout: Duration.seconds(5),
      memorySize: 128,
      logGroup: gatewayToolLogGroup,
    });
    const gatewayRole = new Role(this, "ToolGatewayRole", {
      description: "Least-privilege execution role for the Workmate AgentCore Gateway",
      assumedBy: new ServicePrincipal("bedrock-agentcore.amazonaws.com").withConditions({
        StringEquals: { "aws:SourceAccount": this.account },
        ArnLike: { "aws:SourceArn": `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:gateway/cost-control-tools*` },
      }),
    });
    const toolGateway = new Gateway(this, "ToolGateway", {
      gatewayName: "cost-control-tools",
      description: "Workmate MCP gateway for authenticated Lambda tools",
      authorizerConfiguration: GatewayAuthorizer.usingCognito({
        userPool,
        allowedClients: [userPoolClient],
      }),
      protocolConfiguration: GatewayProtocol.mcp({
        supportedVersions: [MCPProtocolVersion.of("2025-11-25")],
        instructions: "Use the available read-only Workmate business tools when their descriptions match the user request.",
      }),
      role: gatewayRole,
    });
    const supportDirectoryTarget = toolGateway.addLambdaTarget("SupportDirectoryTarget", {
      gatewayTargetName: "SupportDirectory",
      description: "Looks up the contact address and business hours for a support department",
      lambdaFunction: gatewayTool,
      toolSchema: ToolSchema.fromInline([{
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
    });
    const memoryKey = new Key(this, "MemoryKey", {
      alias: "alias/cost-control-cost-control-memory",
      description: "Encrypts Workmate AgentCore Memory",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const memory = new Memory(this, "ChatMemory", {
      memoryName: "workmate_cost_control_memory",
      description: "User-scoped chat history and personal long-term memory",
      expirationDuration: Duration.days(30),
      kmsKey: memoryKey,
      memoryStrategies: [
        new ManagedMemoryStrategy(MemoryStrategyType.SEMANTIC, {
          strategyName: "PersonalFacts",
          description: "Extract durable user facts across chat sessions",
          namespaces: ["/workmate/{actorId}/facts"],
        }),
        new ManagedMemoryStrategy(MemoryStrategyType.USER_PREFERENCE, {
          strategyName: "UserPreferences",
          description: "Extract durable user preferences across chat sessions",
          namespaces: ["/workmate/{actorId}/preferences"],
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
    const bedrockResources = (models: readonly (typeof COST_CONTROLLED_MODEL_CATALOG)[number][]) => models.flatMap((model) => model.modelId.startsWith("us.")
      ? [
        `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${model.modelId}`,
        ...["us-east-1", "us-east-2", "us-west-2"].flatMap((region) => model.foundationModelIds.map((foundationModelId) => `arn:${this.partition}:bedrock:${region}::foundation-model/${foundationModelId}`)),
      ]
      : model.foundationModelIds.map((foundationModelId) => `arn:${this.partition}:bedrock:${this.region}::foundation-model/${foundationModelId}`));
    runtimeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: bedrockResources(COST_CONTROLLED_MODEL_CATALOG),
    }));
    runtimeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["bedrock:CountTokens"],
      resources: bedrockResources(COST_CONTROLLED_MODEL_CATALOG.filter((model) => model.tokenCounter.kind === "bedrock-runtime")),
    }));
    runtimeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["bedrock-mantle:CountTokens"],
      resources: [`arn:${this.partition}:bedrock-mantle:${this.region}:${this.account}:project/default`],
    }));
    runtimeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["bedrock:Retrieve"],
      resources: [`arn:${this.partition}:bedrock:${this.region}:${this.account}:knowledge-base/${knowledgeBaseId.valueAsString}`],
    }));
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
      agentRuntimeName: "strands_agentcore_cost_control",
      description: "Cost Control sample browser-direct AG-UI CodeZip runtime with LLM budget control",
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
        KNOWLEDGE_BASE_ID: knowledgeBaseId.valueAsString,
        MEMORY_ID: memory.memoryId,
        BUDGET_TABLE_NAME: budgetTable.tableName,
        AWS_ACCOUNT_ID: this.account,
        BUDGET_PROJECT_ID: "cost-control",
        ACCOUNT_MONTHLY_BUDGET_NANO_USD: accountBudgetNanoUsd,
        PROJECT_MONTHLY_BUDGET_NANO_USD: projectBudgetNanoUsd,
        USER_LIMIT_PROFILES_JSON: userLimitProfilesJson,
        ...runtimeLogEnvironment,
      },
    });
    agentRuntime.node.addDependency(runtimeUpload);

    // 保持期間を制御するため、サービス任せにせずこちらでロググループを持つ。
    const runtimeLogGroup = new LogGroup(this, "RuntimeLogs", {
      retention: logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
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
          agent: { runtimeArn: agentRuntime.attrAgentRuntimeArn, qualifier: "DEFAULT" },
        }),
      ],
      distribution,
      distributionPaths: ["/*"],
      prune: true,
    });
    webDeployment.node.addDependency(agentRuntime);

    new CfnOutput(this, "ApplicationUrl", { value: applicationUrl });
    new CfnOutput(this, "CloudFrontDomainName", { value: distribution.distributionDomainName });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "CognitoDomain", { value: `${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com` });
    new CfnOutput(this, "EntraRedirectUri", { value: `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com/oauth2/idpresponse` });
    new CfnOutput(this, "AgentRuntimeArn", { value: agentRuntime.attrAgentRuntimeArn });
    new CfnOutput(this, "MemoryId", { value: memory.memoryId });
    new CfnOutput(this, "ToolGatewayUrl", { value: toolGateway.gatewayUrl! });
    new CfnOutput(this, "SupportDirectoryTargetId", { value: supportDirectoryTarget.targetId });
    new CfnOutput(this, "RuntimeArtifactsBucketName", { value: artifactBucket.bucketName });
    new CfnOutput(this, "RuntimeLogGroupName", { value: runtimeLogGroup.logGroupName });
    new CfnOutput(this, "BudgetLedgerTableName", { value: budgetTable.tableName });
    new CfnOutput(this, "AccountMonthlyBudgetUsd", { value: this.node.tryGetContext("accountMonthlyBudgetUsd")?.toString() ?? "100" });
    new CfnOutput(this, "ProjectMonthlyBudgetUsd", { value: this.node.tryGetContext("projectMonthlyBudgetUsd")?.toString() ?? "60" });
    new CfnOutput(this, "UserLimitProfileIds", { value: userLimitProfiles.map((profile) => profile.id).join(",") });
    new CfnOutput(this, "DefaultUserLimitProfileId", { value: defaultUserLimitProfile(userLimitProfiles).id });
  }
}
