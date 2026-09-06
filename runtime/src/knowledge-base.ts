import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  type RetrieveCommandOutput,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { parseKnowledgeBases, type KnowledgeBaseConfig } from "../../shared/deployment-resources.js";

const knowledgeBaseIdSchema = z.string().regex(/^[0-9A-Z]{10}$/u, "Knowledge Base ID must be 10 uppercase alphanumeric characters");
const querySchema = z.string().trim().min(1).max(1_000);
const numberOfResultsSchema = z.number().int().min(1).max(10);

type KnowledgeBaseClient = {
  send(command: RetrieveCommand): Promise<RetrieveCommandOutput>;
};

export type SearchKnowledgeBaseInput = {
  query: string;
  numberOfResults?: number;
};

function retrievalError(error: unknown, knowledgeBaseId: string): Error {
  const awsError = error as Error & { $metadata?: { requestId?: string } };
  const name = typeof awsError?.name === "string" ? awsError.name : "UnknownError";
  const message = typeof awsError?.message === "string" ? awsError.message : String(error);
  const requestId = awsError?.$metadata?.requestId;
  return new Error(
    `Knowledge Base ${knowledgeBaseId} retrieval failed (${name}${requestId ? `, requestId=${requestId}` : ""}): ${message}`,
    { cause: error },
  );
}

export async function searchKnowledgeBase(
  client: KnowledgeBaseClient,
  knowledgeBaseId: string,
  input: SearchKnowledgeBaseInput,
) {
  const validatedKnowledgeBaseId = knowledgeBaseIdSchema.parse(knowledgeBaseId);
  const query = querySchema.parse(input.query);
  const numberOfResults = numberOfResultsSchema.parse(input.numberOfResults ?? 5);

  let response: RetrieveCommandOutput;
  try {
    response = await client.send(new RetrieveCommand({
      knowledgeBaseId: validatedKnowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: { numberOfResults },
      },
    }));
  } catch (error) {
    throw retrievalError(error, validatedKnowledgeBaseId);
  }

  const results = response.retrievalResults ?? [];
  return {
    knowledgeBaseId: validatedKnowledgeBaseId,
    query,
    resultCount: results.length,
    results: results.map((result) => ({
      content: result.content,
      location: result.location,
      score: result.score,
      documentId: result.documentId,
      metadata: result.metadata,
    })),
  };
}

export function createKnowledgeBaseSearchTool(config: KnowledgeBaseConfig) {
  const validatedKnowledgeBaseId = knowledgeBaseIdSchema.parse(config.knowledgeBaseId);
  const client = new BedrockAgentRuntimeClient({ region: config.region });
  return tool({
    name: config.toolName,
    description: config.description,
    inputSchema: z.object({
      query: querySchema.describe("A concise semantic search query."),
      numberOfResults: numberOfResultsSchema.optional().describe(`Number of chunks to return. Defaults to ${config.numberOfResults}.`),
    }),
    callback: (input) => searchKnowledgeBase(client, validatedKnowledgeBaseId, {
      ...input,
      numberOfResults: input.numberOfResults ?? config.numberOfResults,
    }),
  });
}

export function createKnowledgeBaseSearchTools(configured: string) {
  return parseKnowledgeBases(configured)
    .filter((config) => config.enabled)
    .map(createKnowledgeBaseSearchTool);
}
