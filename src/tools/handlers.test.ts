import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CommandError, REVIEW_JOB_ENVELOPE_SCHEMA } from "mergestorm/client";
import { credits } from "./credits.js";
import { reviewGet } from "./review-get.js";
import { reviewList } from "./review-list.js";
import { whoami } from "./whoami.js";

const cfg = {
  apiKey: "msk_live_test_mcp_key",
  apiBase: "https://api.example.test",
};

const meBody = {
  key: {
    prefix: "msk_live_te",
    name: "ci",
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
  },
  plan_key: "starter",
  plan_label_key: "Starter",
  resets_at: "2026-09-01T00:00:00.000Z",
  usage: { standard: { used: 3, limit: 40, remaining: 37 } },
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
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
}

test("whoami returns key prefix and plan without a job envelope", async () => {
  mockFetch(200, meBody);
  const result = await whoami(cfg);
  assert.match(result.summary, /msk_live_te/);
  assert.match(result.summary, /Starter/);
  assert.equal(result.data.key_prefix, "msk_live_te");
  assert.equal(result.data.plan_key, "starter");
  assert.equal(result.data.schema, undefined);
});

test("whoami throws when no API key is configured", async () => {
  originalApiKey = process.env.MERGESTORM_API_KEY;
  delete process.env.MERGESTORM_API_KEY;
  await assert.rejects(
    () => whoami({}),
    (err: unknown) => err instanceof CommandError && err.code === "missing_api_key",
  );
});

test("credits returns usage.standard and resets_at", async () => {
  mockFetch(200, meBody);
  const result = await credits(cfg);
  assert.equal(result.summary, "3 used · 37 remaining");
  assert.deepEqual(result.data.usage, meBody.usage);
  assert.equal(result.data.resets_at, meBody.resets_at);
});

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

test("review_get returns one job envelope", async () => {
  mockFetch(200, {
    job_id: "job_9",
    status: "completed",
    verdict: "request_changes",
    thread_slug: "local/feat",
    summary: "nits",
  });
  const result = await reviewGet("job_9", cfg);
  assert.equal(result.summary, "job_9 · completed · request_changes");
  assert.equal(result.data.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
  assert.equal(result.data.job_id, "job_9");
  assert.equal(result.data.status, "completed");
});

test("review_get returns a structured rate_limited envelope", async () => {
  mockFetch(
    429,
    { error: "rate_limited", retry_after_seconds: 9 },
    { "Retry-After": "9" },
  );
  const result = await reviewGet("job_9", cfg);
  assert.equal(result.data.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
  assert.equal(result.data.job_id, "job_9");
  assert.equal(result.data.status, "rate_limited");
  assert.equal(result.data.retry_after_seconds, 9);
});
