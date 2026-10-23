import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { breezeChatId, registerChatWake } from "./chat-wake.js";

const CHAT = "6a1f0000-0000-4000-8000-000000000001";
const cfg = { apiKey: "ms_test", apiBase: "https://api.example.test" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("a review wake posts the PR, head and first pass to the chat-waits route", async () => {
  const calls = stubFetch(200, { result: "waiting", id: "w1", min_pass: 2 });
  assert.deepEqual(await registerChatWake(cfg, CHAT, { kind: "vortex", owner: "acme", repo: "app", prNumber: 41, headSha: "c188141", minPass: 2 }), { id: "w1", result: "waiting" });
  assert.equal(calls[0]!.url, "https://api.example.test/api/v1/stacks/chat-waits");
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { chat_id: CHAT, kind: "vortex", owner: "acme", repo: "app", pr_number: 41, head_sha: "c188141", min_pass: 2 });
});

test("a pass without a head is not sent, and a stack wake sends only the stack", async () => {
  const calls = stubFetch(200, { result: "existing", id: "w2" });
  await registerChatWake(cfg, CHAT, { kind: "vortex", owner: "acme", repo: "app", prNumber: 41, headSha: null, minPass: 4 });
  assert.equal(JSON.parse(String(calls[0]!.init.body)).min_pass, null);
  assert.deepEqual(await registerChatWake(cfg, CHAT, { kind: "stack", stackId: "s1" }), { id: "w2", result: "existing" });
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { chat_id: CHAT, kind: "stack", stack_id: "s1" });
});

test("a refused or failed registration returns null so the tool answers as it always did", async () => {
  stubFetch(404, { error: "not_found" });
  assert.equal(await registerChatWake(cfg, CHAT, { kind: "stack", stackId: "s1" }), null);
  stubFetch(200, { result: "odd", id: "w" });
  assert.equal(await registerChatWake(cfg, CHAT, { kind: "stack", stackId: "s1" }), null);
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.equal(await registerChatWake(cfg, CHAT, { kind: "stack", stackId: "s1" }), null);
});

test("the server takes the Breeze chat id from its caller or MERGESTORM_CHAT_ID, and ignores anything that is not a chat id", () => {
  assert.equal(breezeChatId(` ${CHAT.toUpperCase()} `), CHAT);
  assert.equal(breezeChatId("chat-1"), null);
  assert.equal(breezeChatId(undefined), null);
});
