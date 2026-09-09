import process from "node:process";

const KEY_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;
const METADATA_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/u;

function nonEmptyString(value, name, maximum = 1_000) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error(`${name} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value.trim();
}

export function parseConfiguredKnowledgeBases(configured) {
  let values;
  try {
    values = JSON.parse(nonEmptyString(configured, "KNOWLEDGE_BASES_JSON", 100_000));
  } catch (cause) {
    throw new Error("KNOWLEDGE_BASES_JSON must contain valid JSON", { cause });
  }
  if (!Array.isArray(values)) throw new Error("KNOWLEDGE_BASES_JSON must contain an array");
  const entries = values.filter((value) => value?.enabled).map((value, index) => {
    const key = nonEmptyString(value?.key, `knowledgeBases[${index}].key`, 40);
    const region = nonEmptyString(value?.region, `knowledgeBases[${index}].region`, 32);
    const knowledgeBaseId = nonEmptyString(value?.knowledgeBaseId, `knowledgeBases[${index}].knowledgeBaseId`, 10);
    if (!KEY_PATTERN.test(key)) throw new Error(`knowledgeBases[${index}].key has an invalid format`);
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(region)) throw new Error(`knowledgeBases[${index}].region has an invalid format`);
    if (!/^[0-9A-Z]{10}$/u.test(knowledgeBaseId)) throw new Error(`knowledgeBases[${index}].knowledgeBaseId has an invalid format`);
    return [key, { key, region, knowledgeBaseId, numberOfResults: value.numberOfResults }];
  });
  if (entries.length === 0) throw new Error("KNOWLEDGE_BASES_JSON must contain at least one enabled Knowledge Base");
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Knowledge Base keys must be unique");
  return new Map(entries);
}

async function retrieveFromBedrock(region, input) {
  const { BedrockAgentRuntimeClient, RetrieveCommand } = await import("@aws-sdk/client-bedrock-agent-runtime");
  const client = new BedrockAgentRuntimeClient({ region });
  return client.send(new RetrieveCommand(input));
}

export function createHandler({ configured = process.env.KNOWLEDGE_BASES_JSON, retrieve = retrieveFromBedrock } = {}) {
  const knowledgeBases = parseConfiguredKnowledgeBases(configured);
  return async (event) => {
    const knowledgeBaseKey = nonEmptyString(event?.knowledgeBaseKey, "knowledgeBaseKey", 40);
    const query = nonEmptyString(event?.query, "query");
    const selected = knowledgeBases.get(knowledgeBaseKey);
    if (!selected) throw new Error(`Unknown knowledgeBaseKey: ${knowledgeBaseKey}`);

    const numberOfResults = event?.numberOfResults ?? selected.numberOfResults ?? 5;
    if (!Number.isInteger(numberOfResults) || numberOfResults < 1 || numberOfResults > 10) {
      throw new Error("numberOfResults must be an integer from 1 to 10");
    }
    const metadataKey = event?.metadataKey;
    const metadataValue = event?.metadataValue;
    if ((metadataKey === undefined) !== (metadataValue === undefined)) {
      throw new Error("metadataKey and metadataValue must be specified together");
    }

    const vectorSearchConfiguration = { numberOfResults };
    if (metadataKey !== undefined) {
      const key = nonEmptyString(metadataKey, "metadataKey", 100);
      if (!METADATA_KEY_PATTERN.test(key)) throw new Error("metadataKey has an invalid format");
      vectorSearchConfiguration.filter = {
        equals: { key, value: nonEmptyString(metadataValue, "metadataValue") },
      };
    }

    const response = await retrieve(selected.region, {
      knowledgeBaseId: selected.knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: { vectorSearchConfiguration },
    });
    const results = response.retrievalResults ?? [];
    return {
      knowledgeBaseKey,
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
  };
}

let defaultHandler;

export async function handler(event) {
  defaultHandler ??= createHandler();
  return defaultHandler(event);
}
