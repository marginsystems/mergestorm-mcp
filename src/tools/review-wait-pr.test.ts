import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { reviewWaitPr } from "./review-wait-pr.js";

const CHAT = "6a1f0000-0000-4000-8000-000000000001";
const cfg = { apiKey: "ms_test", apiBase: "https://api.example.test" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stub() {
  const posted: unknown[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (url.includes("/chat-waits")) {
      posted.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ result: "waiting", id: "w1", min_pass: 3 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      schema: "mergestorm.pr_review/v1", id: "r1", owner: "acme", repo: "app", pr_number: 41, status: "in_progress", raw_status: "in_progress",
      phase: "fanout", verdict: null, head_sha: "c188141aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", pass: 3, review_count: 1, skip_reason: null,
      reviewed_at: null, finding_count: null, findings: null, patch_policy: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return posted;
}

test("review_wait_pr from a Breeze chat registers a wake for the running pass when the wait times out", async () => {
  const posted = stub();
  const result = await reviewWaitPr("acme", "app", 41, "c188141", 1, cfg, { chatId: CHAT, pollIntervalMs: 50 });
  assert.deepEqual(posted, [{ chat_id: CHAT, kind: "vortex", owner: "acme", repo: "app", pr_number: 41, head_sha: "c188141", min_pass: 3 }]);
  assert.match(result.summary, /Keep waiting: call review_wait_pr again until the review finishes.*If your reply ends first, this chat is woken with the review's result/);
  assert.deepEqual((result.data as { chat_wake?: unknown }).chat_wake, { id: "w1", result: "waiting" });
});

test("review_wait_pr without a chat id registers nothing", async () => {
  const posted = stub();
  const result = await reviewWaitPr("acme", "app", 41, "c188141", 1, cfg, { pollIntervalMs: 50 });
  assert.deepEqual(posted, []);
  assert.doesNotMatch(result.summary, /woken/);
});
