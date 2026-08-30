import { describe, expect, it } from "vitest";
import { readMemoryResponse } from "../src/lib/memory-response.js";

describe("readMemoryResponse", () => {
  it("reads a JSON history response", async () => {
    const response = new Response(JSON.stringify({ threads: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    await expect(readMemoryResponse(response)).resolves.toEqual({ threads: [] });
  });

  it("reports an AgentCore SSE error without parsing it as JSON", async () => {
    const response = new Response('data: {"message":"Received error (500) from runtime","type":"RUN_ERROR"}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    await expect(readMemoryResponse(response)).rejects.toThrow("Received error (500) from runtime");
  });

  it("rejects an unexpected response content type", async () => {
    const response = new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });

    await expect(readMemoryResponse(response)).rejects.toThrow("履歴APIのContent-Typeが不正です: text/plain");
  });
});
