import { REVIEW_JOB_ENVELOPE_SCHEMA } from "mergestorm/client";
import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { reviewList } from "./review-list.js";

describe("handlers", { concurrency: false }, () => {

  const cfg = {
    apiKey: "msk_live_test_mcp_key",
    apiBase: "https://api.example.test",
  };

  let originalFetch: typeof globalThis.fetch | undefined;
  let originalApiKey: string | undefined;

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = undefined;
    }
    if (originalApiKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = originalApiKey;
    originalApiKey = undefined;
  });

  function mockFetch(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    originalFetch ??= globalThis.fetch;
    globalThis.fetch = async (input) =>
      new Response(JSON.stringify(
        String(input).includes("/stacks/queue") && status === 200 && body && typeof body === "object" && "stacks" in body
          ? { entries: [] }
          : body,
      ), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      });
  }

  test("review_list wraps jobs in the review envelope", async () => {
    mockFetch(200, {
      items: [
        {
          job_id: "job_1",
          thread_slug: "local/feat",
          status: "completed",
          verdict: "approve",
          summary: "ok",
          base_label: "main",
          head_label: "HEAD",
          created_at: "2026-08-24T00:00:00.000Z",
          finished_at: "2026-08-24T00:01:00.000Z",
          credits: { standard: 1 },
        },
      ],
    });
    const result = await reviewList(10, cfg);
    assert.equal(result.summary, "1 review job");
    const items = result.data.items as { schema: string; job_id: string }[];
    assert.equal(items[0]?.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
    assert.equal(items[0]?.job_id, "job_1");
  });
});
