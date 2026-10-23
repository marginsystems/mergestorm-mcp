import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { reviewSubmit } from "./review-submit.js";

const cfg = { apiKey: "msk_test", apiBase: "http://127.0.0.1:9" };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("review_submit without idempotency_key sends the same derived key when the call is repeated", async () => {
  const posts: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ job_id: "job-1", status: "queued" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };
  const input = { diff: "diff --git a/a.txt b/a.txt\n-one\n+two\n", base: "main" };
  await reviewSubmit(input, cfg);
  await reviewSubmit(input, cfg);
  await reviewSubmit({ ...input, idempotency_key: "caller-key" }, cfg);
  assert.match(String(posts[0]!.idempotency_key), /^mg-auto-[0-9a-f]{64}$/);
  assert.equal(posts[1]!.idempotency_key, posts[0]!.idempotency_key);
  assert.equal(posts[2]!.idempotency_key, "caller-key");
});
