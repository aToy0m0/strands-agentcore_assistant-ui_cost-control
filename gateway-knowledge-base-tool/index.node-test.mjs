import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHandler } from "./index.mjs";

const configured = JSON.stringify([{
  key: "internal-documents",
  enabled: true,
  region: "us-east-1",
  knowledgeBaseId: "ABCDEFGHIJ",
  numberOfResults: 5,
}]);

describe("Knowledge Base Gateway Lambda", () => {
  it("logical key and metadata equality filter are converted to Retrieve input", async () => {
    let actual;
    const handler = createHandler({
      configured,
      retrieve: async (region, input) => {
        actual = { region, input };
        return { retrievalResults: [{ content: { text: "result" }, metadata: { department: "sales" } }] };
      },
    });
    const result = await handler({
      knowledgeBaseKey: "internal-documents",
      query: "expense policy",
      numberOfResults: 3,
      metadataKey: "department",
      metadataValue: "sales",
    });
    assert.equal(actual.region, "us-east-1");
    assert.deepEqual(actual.input.retrievalConfiguration.vectorSearchConfiguration, {
      numberOfResults: 3,
      filter: { equals: { key: "department", value: "sales" } },
    });
    assert.equal(result.resultCount, 1);
    assert.deepEqual(result.results[0].metadata, { department: "sales" });
  });

  it("rejects an unknown logical key", async () => {
    const handler = createHandler({ configured, retrieve: async () => ({}) });
    await assert.rejects(() => handler({ knowledgeBaseKey: "unknown", query: "test" }), /Unknown knowledgeBaseKey/u);
  });

  it("requires both metadata filter fields", async () => {
    const handler = createHandler({ configured, retrieve: async () => ({}) });
    await assert.rejects(
      () => handler({ knowledgeBaseKey: "internal-documents", query: "test", metadataKey: "department" }),
      /must be specified together/u,
    );
  });
});
