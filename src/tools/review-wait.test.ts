import { REVIEW_JOB_ENVELOPE_SCHEMA } from "mergestorm/client";
import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { reviewWait } from "./review-wait.js";

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

  test("review_wait with timeout_s 0 reads one job envelope without polling", async () => {
    const urls: string[] = [];
    originalFetch ??= globalThis.fetch;
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return Response.json({
        job_id: "job_9",
        status: "in_progress",
        thread_slug: "local/feat",
      });
    };
    const result = await reviewWait("job_9", 0, cfg, { pollIntervalMs: 1 });
    assert.equal(urls.length, 1);
    assert.equal(result.summary, "job_9 · in_progress");
    assert.equal(result.data.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
    assert.equal(result.data.job_id, "job_9");
    assert.equal(result.data.status, "in_progress");
    assert.equal(result.data.error ?? null, null);
  });

  test("review_wait with timeout_s 0 returns one completed job envelope", async () => {
    mockFetch(200, {
      job_id: "job_9",
      status: "completed",
      verdict: "request_changes",
      thread_slug: "local/feat",
      summary: "nits",
    });
    const result = await reviewWait("job_9", 0, cfg);
    assert.equal(result.summary, "job_9 · completed · request_changes");
    assert.equal(result.data.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
    assert.equal(result.data.job_id, "job_9");
    assert.equal(result.data.status, "completed");
  });

  test("review_wait with timeout_s 0 returns a structured rate_limited envelope", async () => {
    mockFetch(
      429,
      { error: "rate_limited", retry_after_seconds: 9 },
      { "Retry-After": "9" },
    );
    const result = await reviewWait("job_9", 0, cfg);
    assert.equal(result.data.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
    assert.equal(result.data.job_id, "job_9");
    assert.equal(result.data.status, "rate_limited");
    assert.equal(result.data.retry_after_seconds, 9);
  });
});

describe("review-write", { concurrency: false }, () => {
  const cfg = {
    apiKey: "msk_live_test_mcp_write",
    apiBase: "https://api.example.test",
  };

  let originalFetch: typeof globalThis.fetch | undefined;

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = undefined;
    }
  });

  function mockReviewFetch(
    responses: { status: number; body: unknown; raw?: boolean; headers?: Record<string, string> }[],
  ): { calls: () => number; posts: () => unknown[] } {
    originalFetch = globalThis.fetch;
    let n = 0;
    const posts: unknown[] = [];
    globalThis.fetch = async (_url, init) => {
      if (String(init?.method ?? "GET").toUpperCase() === "POST" && init?.body) {
        posts.push(JSON.parse(String(init.body)));
      }
      const r = responses[Math.min(n, responses.length - 1)]!;
      n += 1;
      return new Response(r.raw ? String(r.body) : JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json", ...r.headers },
      });
    };
    return { calls: () => n, posts: () => posts };
  }

  describe("review write tools", { concurrency: false }, () => {

    test("review_wait polls until completed", async () => {
      mockReviewFetch([
        { status: 200, body: { job_id: "job_w", status: "queued" } },
        { status: 200, body: { job_id: "job_w", status: "completed", verdict: "approve" } },
      ]);
      const result = await reviewWait("job_w", 2, cfg, { pollIntervalMs: 1 });
      assert.equal(result.data.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
      assert.equal(result.data.job_id, "job_w");
      assert.equal(result.data.status, "completed");
      assert.equal(result.data.verdict, "approve");
    });

    test("review_wait timeout returns in_progress", async () => {
      mockReviewFetch([
        { status: 200, body: { job_id: "job_hang", status: "in_progress" } },
      ]);
      const result = await reviewWait("job_hang", 0.05, cfg, { pollIntervalMs: 1 });
      assert.equal(result.data.job_id, "job_hang");
      assert.equal(result.data.status, "in_progress");
    });

    test("review_wait returns rate_limited after poll retries", async () => {
      mockReviewFetch([
        {
          status: 429,
          body: { error: "rate_limited", retry_after_seconds: 0 },
          headers: { "Retry-After": "0" },
        },
      ]);
      const result = await reviewWait("job_limited", 60, cfg, { pollIntervalMs: 1 });
      assert.equal(result.data.job_id, "job_limited");
      assert.equal(result.data.status, "rate_limited");
      assert.equal(result.data.retry_after_seconds, 0);
    });
  });
});
