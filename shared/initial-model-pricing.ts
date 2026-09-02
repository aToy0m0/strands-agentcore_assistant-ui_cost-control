export type InitialModelPricing = {
  modelId: string;
  status: "ACTIVE";
  currency: "USD";
  sourceRegion: "us-east-1";
  routing: "geo-us" | "in-region";
  serviceTier: "standard";
  inputNanoUsdPerMillionTokens: string;
  outputNanoUsdPerMillionTokens: string;
  verifiedAt: string;
  verifiedUntil: string;
  version: string;
  productId?: string;
  sources: readonly string[];
  priceList: {
    serviceCode: "AmazonBedrock" | "AmazonBedrockFoundationModels";
    productAttributeName: "model" | "servicename";
    productAttributeValue: string;
    inputUsageType: string;
    outputUsageType: string;
  };
};

const verifiedUntil = "2026-09-30T23:59:59.999Z";

export const INITIAL_MODEL_PRICING: readonly InitialModelPricing[] = [
  {
    modelId: "us.amazon.nova-2-lite-v1:0",
    status: "ACTIVE",
    currency: "USD",
    sourceRegion: "us-east-1",
    routing: "geo-us",
    serviceTier: "standard",
    inputNanoUsdPerMillionTokens: "330000000",
    outputNanoUsdPerMillionTokens: "2750000000",
    verifiedAt: "2026-09-01T15:07:33.755Z",
    verifiedUntil,
    version: "2026-09-01-nova-2-lite",
    sources: ["AWS_PRICE_LIST:AmazonBedrock:Nova 2.0 Lite"],
    priceList: { serviceCode: "AmazonBedrock", productAttributeName: "model", productAttributeValue: "Nova 2.0 Lite", inputUsageType: "USE1-Nova2.0Lite-input-tokens", outputUsageType: "USE1-Nova2.0Lite-output-tokens" },
  },
  {
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    status: "ACTIVE",
    currency: "USD",
    sourceRegion: "us-east-1",
    routing: "geo-us",
    serviceTier: "standard",
    inputNanoUsdPerMillionTokens: "1100000000",
    outputNanoUsdPerMillionTokens: "5500000000",
    verifiedAt: "2026-08-30T00:00:00.000Z",
    verifiedUntil,
    version: "2026-08-30-claude-haiku-4-5",
    productId: "prod-xdkflymybwmvi",
    sources: ["AWS_PRICE_LIST:AmazonBedrockFoundationModels:Claude Haiku 4.5 (Amazon Bedrock Edition)"],
    priceList: { serviceCode: "AmazonBedrockFoundationModels", productAttributeName: "servicename", productAttributeValue: "Claude Haiku 4.5 (Amazon Bedrock Edition)", inputUsageType: "USE1-MP:USE1_InputTokenCount-Units", outputUsageType: "USE1-MP:USE1_OutputTokenCount-Units" },
  },
  {
    modelId: "us.anthropic.claude-sonnet-4-6",
    status: "ACTIVE",
    currency: "USD",
    sourceRegion: "us-east-1",
    routing: "geo-us",
    serviceTier: "standard",
    inputNanoUsdPerMillionTokens: "3300000000",
    outputNanoUsdPerMillionTokens: "16500000000",
    verifiedAt: "2026-08-30T00:00:00.000Z",
    verifiedUntil,
    version: "2026-08-30-claude-sonnet-4-6",
    productId: "prod-ffvjxvh4ltq64",
    sources: ["AWS_PRICE_LIST:AmazonBedrockFoundationModels:Claude Sonnet 4.6 (Amazon Bedrock Edition)"],
    priceList: { serviceCode: "AmazonBedrockFoundationModels", productAttributeName: "servicename", productAttributeValue: "Claude Sonnet 4.6 (Amazon Bedrock Edition)", inputUsageType: "USE1-MP:USE1_InputTokenCount-Units", outputUsageType: "USE1-MP:USE1_OutputTokenCount-Units" },
  },
  {
    modelId: "us.anthropic.claude-sonnet-5",
    status: "ACTIVE",
    currency: "USD",
    sourceRegion: "us-east-1",
    routing: "geo-us",
    serviceTier: "standard",
    inputNanoUsdPerMillionTokens: "2200000000",
    outputNanoUsdPerMillionTokens: "11000000000",
    verifiedAt: "2026-09-02T00:00:00.000Z",
    verifiedUntil,
    version: "2026-09-02-claude-sonnet-5",
    productId: "prod-4ezhkeia6k2cs",
    sources: ["AWS_PRICE_LIST:AmazonBedrockFoundationModels:Claude Sonnet 5 (Amazon Bedrock Edition)"],
    priceList: { serviceCode: "AmazonBedrockFoundationModels", productAttributeName: "servicename", productAttributeValue: "Claude Sonnet 5 (Amazon Bedrock Edition)", inputUsageType: "USE1-MP:USE1_input_tokens_standard-Units", outputUsageType: "USE1-MP:USE1_output_tokens_standard-Units" },
  },
  {
    modelId: "openai.gpt-oss-20b-1:0",
    status: "ACTIVE",
    currency: "USD",
    sourceRegion: "us-east-1",
    routing: "in-region",
    serviceTier: "standard",
    inputNanoUsdPerMillionTokens: "70000000",
    outputNanoUsdPerMillionTokens: "300000000",
    verifiedAt: "2026-09-01T15:07:33.755Z",
    verifiedUntil,
    version: "2026-09-01-gpt-oss-20b",
    sources: ["AWS_PRICE_LIST:AmazonBedrock:gpt-oss-20b"],
    priceList: { serviceCode: "AmazonBedrock", productAttributeName: "model", productAttributeValue: "gpt-oss-20b", inputUsageType: "USE1-gpt-oss-20b-input-tokens", outputUsageType: "USE1-gpt-oss-20b-output-tokens" },
  },
  {
    modelId: "openai.gpt-oss-120b-1:0",
    status: "ACTIVE",
    currency: "USD",
    sourceRegion: "us-east-1",
    routing: "in-region",
    serviceTier: "standard",
    inputNanoUsdPerMillionTokens: "150000000",
    outputNanoUsdPerMillionTokens: "600000000",
    verifiedAt: "2026-09-01T15:07:33.755Z",
    verifiedUntil,
    version: "2026-09-01-gpt-oss-120b",
    sources: ["AWS_PRICE_LIST:AmazonBedrock:gpt-oss-120b"],
    priceList: { serviceCode: "AmazonBedrock", productAttributeName: "model", productAttributeValue: "gpt-oss-120b", inputUsageType: "USE1-gpt-oss-120b-input-tokens", outputUsageType: "USE1-gpt-oss-120b-output-tokens" },
  },
  {
    modelId: "zai.glm-4.7-flash",
    status: "ACTIVE",
    currency: "USD",
    sourceRegion: "us-east-1",
    routing: "in-region",
    serviceTier: "standard",
    inputNanoUsdPerMillionTokens: "70000000",
    outputNanoUsdPerMillionTokens: "400000000",
    verifiedAt: "2026-09-01T15:07:33.755Z",
    verifiedUntil,
    version: "2026-09-01-glm-4-7-flash",
    sources: ["AWS_PRICE_LIST:AmazonBedrock:GLM 4.7 Flash"],
    priceList: { serviceCode: "AmazonBedrock", productAttributeName: "model", productAttributeValue: "GLM 4.7 Flash", inputUsageType: "USE1-zai.glm-4.7-flash-input-tokens", outputUsageType: "USE1-zai.glm-4.7-flash-output-tokens" },
  },
  {
    modelId: "zai.glm-4.7",
    status: "ACTIVE",
    currency: "USD",
    sourceRegion: "us-east-1",
    routing: "in-region",
    serviceTier: "standard",
    inputNanoUsdPerMillionTokens: "600000000",
    outputNanoUsdPerMillionTokens: "2200000000",
    verifiedAt: "2026-09-01T15:07:33.755Z",
    verifiedUntil,
    version: "2026-09-01-glm-4-7",
    sources: ["AWS_PRICE_LIST:AmazonBedrock:GLM 4.7"],
    priceList: { serviceCode: "AmazonBedrock", productAttributeName: "model", productAttributeValue: "GLM 4.7", inputUsageType: "USE1-zai.glm-4.7-input-tokens", outputUsageType: "USE1-zai.glm-4.7-output-tokens" },
  },
] as const;
