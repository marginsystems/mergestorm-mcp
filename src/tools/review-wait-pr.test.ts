import type { PrVortexReview } from "mergestorm/client";
import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { reviewWaitPr } from "./review-wait-pr.js";

describe("review-wait-pr", { concurrency: false }, () => {
  const CHAT = "6a1f0000-0000-4000-8000-000000000001";
  const cfg = { apiKey: "ms_test", apiBase: "https://api.example.test" };
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function stub() {
    const posted: unknown[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (url.includes("/chat-waits")) {
        posted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ task: { id: "t1", title: "Review acme/app#41" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        schema: "mergestorm.pr_review/v1", id: "r1", owner: "acme", repo: "app", pr_number: 41, status: "in_progress", raw_status: "in_progress",
        phase: "fanout", verdict: null, head_sha: "c188141aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", pass: 3, review_count: 1, skip_reason: null,
        reviewed_at: null, finding_count: null, findings: null, patch_policy: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    return posted;
  }

  test("review_wait_pr from a Breeze chat tracks the review as a background task when the wait times out", async () => {
    const posted = stub();
    const result = await reviewWaitPr("acme", "app", 41, "c188141", 1, cfg, { chatId: CHAT, pollIntervalMs: 50 });
    assert.deepEqual(posted, [{ chat_id: CHAT, kind: "review", owner: "acme", repo: "app", pr_number: 41 }]);
    assert.match(result.summary, /This chat tracks it as background task t1 "Review acme\/app#41"/);
    assert.deepEqual((result.data as { background_task?: unknown }).background_task, { id: "t1", title: "Review acme/app#41" });
  });

  test("review_wait_pr without a chat id registers nothing", async () => {
    const posted = stub();
    const result = await reviewWaitPr("acme", "app", 41, "c188141", 1, cfg, { pollIntervalMs: 50 });
    assert.deepEqual(posted, []);
    assert.doesNotMatch(result.summary, /woken/);
  });
});

describe("review-pr", { concurrency: false }, () => {
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
    test("review_wait_pr with timeout_s 0 fetches only the DB-only PR review route", async () => {
      const urls = mockPrFetch([{ status: 200, body: review("completed") }]);

      const result = await reviewWaitPr("acme", "widgets", 12, undefined, 0, cfg);

      assert.equal(urls.length, 1);
      assert.equal(
        urls[0],
        "https://api.example.test/api/v1/stacks/pr-review?owner=acme&repo=widgets&pr_number=12",
      );
      assert.equal(urls[0]?.includes("/stacks/enrich"), false);
      assert.equal(urls[0]?.includes("/api/v1/reviews"), false);
      assert.equal(result.data.schema, "mergestorm.pr_review/v1");
      assert.equal(
        result.summary,
        "acme/widgets#12 · completed · sha abc123d · 0 findings",
      );
    });

    test("review_wait_pr with timeout_s 0 makes one request and does not poll", async () => {
      const urls = mockPrFetch([
        { status: 200, body: review("in_progress") },
        { status: 200, body: review("completed") },
      ]);

      const result = await reviewWaitPr(
        "acme",
        "widgets",
        12,
        "abc123def456",
        0,
        cfg,
        { pollIntervalMs: 1 },
      );

      assert.equal(urls.length, 1);
      assert.equal(new URL(urls[0]!).searchParams.get("wait"), null);
      assert.equal(new URL(urls[0]!).searchParams.get("after_sha"), "abc123def456");
      assert.equal(result.data.status, "in_progress");
      assert.equal(result.data.error, undefined);
    });

    test("review_wait_pr with timeout_s 0 returns rate_limited without retrying", async () => {
      const urls = mockPrFetch([
        {
          status: 429,
          body: { error: "rate_limited", retry_after_seconds: 7 },
          headers: { "Retry-After": "7" },
        },
      ]);

      const result = await reviewWaitPr("acme", "widgets", 12, undefined, 0, cfg);

      assert.equal(urls.length, 1);
      assert.equal(result.data.status, "rate_limited");
      assert.equal(result.data.retry_after_seconds, 7);
    });

    test("review_wait_pr with timeout_s 0 reports not_found for a head with no pass yet", async () => {
      const urls = mockPrFetch([{ status: 404, body: { error: "not_found" } }]);

      await assert.rejects(
        () => reviewWaitPr("acme", "widgets", 12, "abc123def456", 0, cfg),
        (err: unknown) => err instanceof Error && (err as { code?: string }).code === "not_found",
      );
      assert.equal(urls.length, 1);
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
      assert.equal(result.data.finding_count, null);
      assert.match(String(result.data.error), /Timed out waiting/);
    });

    test("review_wait_pr timeout with no review ever seen returns none and says what to do, not in_progress", async () => {
      const urls = mockPrFetch([{ status: 404, body: { error: "not_found" } }]);

      const result = await reviewWaitPr(
        "acme",
        "widgets",
        12,
        "abc123def456",
        0.01,
        cfg,
        { pollIntervalMs: 1, afterPass: 1 },
      );

      assert.ok(urls.length >= 1);
      assert.equal(result.data.status, "none");
      assert.equal(result.data.head_sha, null);
      assert.equal(result.data.pass, null);
      assert.equal(result.data.finding_count, null);
      assert.match(String(result.data.error), /^Timed out waiting for PR review acme\/widgets#12\. No Vortex pass after pass 1 exists for acme\/widgets#12 at abc123def456 yet\./);
      assert.match(String(result.data.error), /comment "@mergestorm-vortex review" on the PR to run it, or review the branch locally with mg review/);
      assert.match(result.summary, /^acme\/widgets#12 · none · No Vortex pass after pass 1 exists/);
      assert.doesNotMatch(result.summary, /in_progress/);
    });

    test("review_wait_pr timeout on a resting mismatched SHA stays in_progress and is not a completion", async () => {
      mockPrFetch([{
        status: 200,
        body: {
          ...review("completed", "def456789abc"),
          raw_status: "completed",
          findings: [{ rule: "foreign-pass" }],
        },
      }]);

      const result = await reviewWaitPr(
        "acme",
        "widgets",
        12,
        "abc123def456",
        0.01,
        cfg,
        { pollIntervalMs: 1 },
      );

      assert.equal(result.data.status, "in_progress");
      assert.equal(result.data.raw_status, undefined);
      assert.equal(result.data.verdict, undefined);
      assert.equal(result.data.findings, undefined);
      assert.equal(result.data.finding_count, null);
      assert.equal(result.data.head_sha, "def456789abc");
      assert.equal(result.data.pass, null);
      assert.match(result.summary, /in_progress/);
      assert.doesNotMatch(result.summary, /completed/);
      assert.doesNotMatch(result.summary, /0 findings/);
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
  });

  test("timeout_s 0 forwards SHA and exact pass", async () => {
    const urls = mockPrFetch([{ status: 200, body: { ...review("completed"), pass: 2 } }]);
    const result = await reviewWaitPr("acme", "widgets", 12, "abc123d", 0, cfg, { pass: 2 });
    assert.equal(urls.length, 1);
    const query = new URL(urls[0]!).searchParams;
    assert.equal(query.get("after_sha"), "abc123d");
    assert.equal(query.get("pass"), "2");
    assert.equal(result.data.pass, 2);
  });

  test("wait keeps after_pass fixed until a later pass completes", async () => {
    const urls = mockPrFetch([
      { status: 200, body: { ...review("completed"), pass: 1 } },
      { status: 200, body: { ...review("in_progress"), pass: 2 } },
      { status: 200, body: { ...review("completed"), pass: 2 } },
    ]);
    const result = await reviewWaitPr("acme", "widgets", 12, "abc123d", 1, cfg, { afterPass: 1, pollIntervalMs: 1 });
    assert.equal(result.data.pass, 2);
    assert.equal(urls.length, 3);
    for (const url of urls) assert.equal(new URL(url).searchParams.get("after_pass"), "1");
  });

  test("review_wait_pr default slice is one read-only wait=45 GET", async (t) => {
    let now = 0;
    let calls = 0;
    t.mock.method(Date, "now", () => now);
    t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
      calls++;
      const url = new URL(input);
      assert.equal(url.pathname, "/api/v1/stacks/pr-review");
      assert.equal(url.searchParams.get("wait"), "45");
      assert.equal(init?.method ?? "GET", "GET");
      now += 45_000;
      return Response.json(review("in_progress"));
    });
    const result = await reviewWaitPr("acme", "widgets", 12, undefined, undefined, cfg);
    assert.equal(calls, 1);
    assert.equal(result.data.status, "in_progress");
  });
});
