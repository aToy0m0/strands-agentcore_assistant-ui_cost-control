import { RetrieveCommand, type RetrieveCommandOutput } from "@aws-sdk/client-bedrock-agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { searchKnowledgeBase } from "./knowledge-base.js";

describe("search_knowledge_base", () => {
  it("指定したKnowledge Baseを検索し、本文と出典を返す", async () => {
    const send = vi.fn(async (_command: RetrieveCommand): Promise<RetrieveCommandOutput> => ({
      retrievalResults: [{
        content: { type: "TEXT", text: "休暇申請は社内ポータルから行います。" },
        location: { type: "S3", s3Location: { uri: "s3://company-docs/hr/leave.md" } },
        score: 0.91,
        documentId: "leave-policy",
        metadata: { category: "hr" },
      }],
      $metadata: {},
    }));

    const result = await searchKnowledgeBase({ send }, "ABCDEFGHIJ", {
      query: "休暇の申請方法",
      numberOfResults: 3,
    });

    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(RetrieveCommand);
    expect(command?.input).toEqual({
      knowledgeBaseId: "ABCDEFGHIJ",
      retrievalQuery: { text: "休暇の申請方法" },
      retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 3 } },
    });
    expect(result).toEqual({
      knowledgeBaseId: "ABCDEFGHIJ",
      query: "休暇の申請方法",
      resultCount: 1,
      results: [{
        content: { type: "TEXT", text: "休暇申請は社内ポータルから行います。" },
        location: { type: "S3", s3Location: { uri: "s3://company-docs/hr/leave.md" } },
        score: 0.91,
        documentId: "leave-policy",
        metadata: { category: "hr" },
      }],
    });
  });

  it("取得件数の既定値は5で、0件を正常結果として返す", async () => {
    const send = vi.fn(async (_command: RetrieveCommand): Promise<RetrieveCommandOutput> => ({ retrievalResults: [], $metadata: {} }));
    const result = await searchKnowledgeBase({ send }, "ABCDEFGHIJ", { query: "該当しない情報" });

    expect(send.mock.calls[0]?.[0].input.retrievalConfiguration).toEqual({
      vectorSearchConfiguration: { numberOfResults: 5 },
    });
    expect(result.resultCount).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("AWSエラーへKnowledge Base IDとリクエストIDを付けて失敗する", async () => {
    const error = Object.assign(new Error("Access denied"), {
      name: "AccessDeniedException",
      $metadata: { requestId: "request-123" },
    });
    const send = vi.fn(async (_command: RetrieveCommand): Promise<RetrieveCommandOutput> => { throw error; });

    await expect(searchKnowledgeBase({ send }, "ABCDEFGHIJ", { query: "検索" }))
      .rejects.toThrow("Knowledge Base ABCDEFGHIJ retrieval failed (AccessDeniedException, requestId=request-123): Access denied");
  });

  it("不正な入力ではAPIを呼び出さない", async () => {
    const send = vi.fn(async (_command: RetrieveCommand): Promise<RetrieveCommandOutput> => ({ retrievalResults: [], $metadata: {} }));

    await expect(searchKnowledgeBase({ send }, "invalid", { query: "検索" })).rejects.toThrow("Knowledge Base ID");
    await expect(searchKnowledgeBase({ send }, "ABCDEFGHIJ", { query: "   " })).rejects.toThrow();
    await expect(searchKnowledgeBase({ send }, "ABCDEFGHIJ", { query: "検索", numberOfResults: 11 })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
