import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { REVIEW_START_WAIT_NOTE } from "./chat-wake.js";
import { reviewStartPr, reviewStopPr } from "./review-start.js";

const CHAT = "6a1f0000-0000-4000-8000-000000000001";
const cfg = { apiKey: "ms_test", apiBase: "https://api.example.test" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("starting a review sends the pull request, the expected head and the chat, and says the chat will be woken", async () => {
  const calls = stubFetch(202, { started: true, chat_wake: "waiting", message: "Vortex review started on acme/app#4 at abc1234." });
  const payload = await reviewStartPr({ owner: "acme", repo: "app", pr_number: 4, head_sha: "abc1234" }, cfg, CHAT);
  assert.equal(calls[0]!.url, "https://api.example.test/api/v1/agents/vortex/review");
  assert.deepEqual(calls[0]!.body, { owner: "acme", repo: "app", pr_number: 4, head_sha: "abc1234", chat_id: CHAT });
  assert.equal(payload.summary, `Vortex review started on acme/app#4 at abc1234. ${REVIEW_START_WAIT_NOTE}`);
});

test("outside a chat nothing about a chat is sent or said", async () => {
  const calls = stubFetch(202, { started: true, chat_wake: null, message: "Vortex review started on acme/app#4." });
  const payload = await reviewStartPr({ owner: "acme", repo: "app", pr_number: 4 }, cfg, null);
  assert.deepEqual(calls[0]!.body, { owner: "acme", repo: "app", pr_number: 4 });
  assert.equal(payload.summary, "Vortex review started on acme/app#4.");
});

test("stopping a review posts the pull request to the stop route", async () => {
  const calls = stubFetch(200, { stopped: false, reason: "not_running", message: "No Vortex review is running on acme/app#4; nothing to cancel." });
  const payload = await reviewStopPr({ owner: "acme", repo: "app", pr_number: 4 }, cfg);
  assert.equal(calls[0]!.url, "https://api.example.test/api/v1/agents/vortex/stop");
  assert.deepEqual(calls[0]!.body, { owner: "acme", repo: "app", pr_number: 4 });
  assert.match(payload.summary, /nothing to cancel/);
});
