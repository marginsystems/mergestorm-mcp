import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { breezeChatId, chatTaskNote, trackInChat } from "./chat-task.js";

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

test("a review is tracked by posting the pull request to the chat-waits route", async () => {
  const calls = stubFetch(200, { task: { id: "t1", title: "Review acme/app#41" } });
  assert.deepEqual(await trackInChat(cfg, CHAT, { kind: "review", owner: "acme", repo: "app", prNumber: 41 }), { id: "t1", title: "Review acme/app#41" });
  assert.equal(calls[0]!.url, "https://api.example.test/api/v1/stacks/chat-waits");
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { chat_id: CHAT, kind: "review", owner: "acme", repo: "app", pr_number: 41 });
});

test("a stack is tracked by its id alone", async () => {
  const calls = stubFetch(200, { task: { id: "t2", title: "Land the stack on acme/app" } });
  assert.deepEqual(await trackInChat(cfg, CHAT, { kind: "stack", stackId: "s1" }), { id: "t2", title: "Land the stack on acme/app" });
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { chat_id: CHAT, kind: "stack", stack_id: "s1" });
});

test("a refused or failed registration returns null so the tool answers as it always did", async () => {
  stubFetch(404, { error: "not_found" });
  assert.equal(await trackInChat(cfg, CHAT, { kind: "stack", stackId: "s1" }), null);
  stubFetch(200, { task: { id: 3 } });
  assert.equal(await trackInChat(cfg, CHAT, { kind: "stack", stackId: "s1" }), null);
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.equal(await trackInChat(cfg, CHAT, { kind: "stack", stackId: "s1" }), null);
});

test("the note names the background task, not the agent doing the work", () => {
  assert.equal(chatTaskNote({ id: "t1", title: "Review acme/app#41" }), 'This chat tracks it as background task t1 "Review acme/app#41" and is told the result when it ends. If the user is waiting for the outcome, wait for it before you end the reply, then tell them what actually happened.');
});

test("the server takes the Breeze chat id from its caller or MERGESTORM_CHAT_ID, and ignores anything that is not a chat id", () => {
  assert.equal(breezeChatId(` ${CHAT.toUpperCase()} `), CHAT);
  assert.equal(breezeChatId("chat-1"), null);
  assert.equal(breezeChatId(undefined), null);
});
