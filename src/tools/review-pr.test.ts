import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { PrVortexReview } from "mergestorm/client";
import { MCP_TOOL_NAMES } from "../server.js";
import { reviewGetPr } from "./review-get-pr.js";
import { reviewWaitPr } from "./review-wait-pr.js";

const cfg = {
  apiKey: "msk_live_test_mcp_pr",
  apiBase: "https://api.example.test",
};

const originalFetch = globalThis.fetch;
const originalRandom = Math.random;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
});

function review(
  status: string,
  headSha = "abc123def456",
): PrVortexReview {
  return {
    schema: "mergestorm.pr_review/v1",
    id: `review-${status}-${headSha}`,
    owner: "acme",
    repo: "widgets",
    pr_number: 12,
    status,
    phase: null,
    verdict: status === "completed" ? "approve" : null,
    head_sha: headSha,
    review_count: 1,
    skip_reason: null,
    reviewed_at: null,
    finding_count: 0,
    findings: null,
    patch_policy: null,
  };
}

function mockPrFetch(
  responses: {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }[],
) {
  const urls: string[] = [];
  let index = 0;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        ...response.headers,
      },
    });
  };
  return urls;
}

describe("PR review tools", { concurrency: false }, () => {
  test("review_get_pr fetches only the DB-only PR review route", async () => {
    const urls = mockPrFetch([{ status: 200, body: review("completed") }]);

    const result = await reviewGetPr("acme", "widgets", 12, cfg);

    assert.equal(urls.length, 1);
    assert.equal(
      urls[0],
      "https://api.example.test/api/v1/stacks/pr-review?owner=acme&repo=widgets&pr_number=12",
    );
    assert.equal(urls[0]?.includes("/stacks/enrich"), false);
    assert.equal(urls[0]?.includes("/api/v1/reviews"), false);
    assert.equal(result.data.schema, "mergestorm.pr_review/v1");
  });

  test("review_wait_pr polls until the pass completes", async () => {
    const urls = mockPrFetch([
      { status: 200, body: review("in_progress") },
      { status: 200, body: review("completed") },
    ]);

    const result = await reviewWaitPr(
      "acme",
      "widgets",
      12,
      undefined,
      0.1,
      cfg,
      { pollIntervalMs: 1 },
    );

    assert.equal(urls.length, 2);
    assert.equal(result.data.status, "completed");
  });

  test("review_wait_pr passes after_sha to the shared client poll", async () => {
    const urls = mockPrFetch([
      { status: 200, body: review("completed", "def456789abc") },
      { status: 200, body: review("completed", "abc123def456") },
    ]);

    const result = await reviewWaitPr(
      "acme",
      "widgets",
      12,
      "abc123def456",
      0.1,
      cfg,
      { pollIntervalMs: 1 },
    );

    assert.equal(urls.length, 2);
    assert.match(urls[0]!, /after_sha=abc123def456/);
    assert.equal(result.data.head_sha, "abc123def456");
  });

  test("review_wait_pr timeout returns in_progress", async () => {
    mockPrFetch([{ status: 200, body: review("in_progress") }]);

    const result = await reviewWaitPr(
      "acme",
      "widgets",
      12,
      undefined,
      0.01,
      cfg,
      { pollIntervalMs: 1 },
    );

    assert.equal(result.data.status, "in_progress");
    assert.match(String(result.data.error), /Timed out waiting/);
  });

  test("review_wait_pr timeout preserves a resting mismatched-SHA status", async () => {
    mockPrFetch([{ status: 200, body: review("completed", "def456789abc") }]);

    const result = await reviewWaitPr(
      "acme",
      "widgets",
      12,
      "abc123def456",
      0.01,
      cfg,
      { pollIntervalMs: 1 },
    );

    assert.equal(result.data.status, "completed");
    assert.equal(result.data.head_sha, "def456789abc");
    assert.match(result.summary, /· completed$/);
  });

  test("review_wait_pr returns rate_limited after retry exhaustion", async () => {
    Math.random = () => -1;
    mockPrFetch([
      {
        status: 429,
        body: { error: "rate_limited", retry_after_seconds: 0 },
        headers: { "Retry-After": "0" },
      },
    ]);

    const result = await reviewWaitPr(
      "acme",
      "widgets",
      12,
      undefined,
      1,
      cfg,
      { pollIntervalMs: 1 },
    );

    assert.equal(result.data.status, "rate_limited");
    assert.equal(result.data.retry_after_seconds, 0);
  });

  test("registers PR review tools without changing stack tools", () => {
    assert.ok(MCP_TOOL_NAMES.includes("review_get_pr"));
    assert.ok(MCP_TOOL_NAMES.includes("review_wait_pr"));
    assert.deepEqual(
      MCP_TOOL_NAMES.filter((name) => name.startsWith("stack_")),
      ["stack_list", "stack_status"],
    );
  });
});
