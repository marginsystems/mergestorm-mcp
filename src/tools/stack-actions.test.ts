import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chatTaskNote } from "./chat-task.js";
import { stackEnqueue, stackRestack } from "./stack-actions.js";

const CHAT = "6a1f0000-0000-4000-8000-000000000001";
const STACK = "8c3f0000-0000-4000-8000-000000000003";
const cfg = { apiKey: "ms_test", apiBase: "https://api.example.test" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null });
    const path = new URL(url).pathname;
    return new Response(JSON.stringify(routes[path] ?? { error: "not_found" }), { status: path in routes ? 200 : 404 });
  }) as typeof fetch;
  return calls;
}

test("restack posts to the stack's restack route and carries the watch obligation", async () => {
  const calls = stubFetch({ [`/api/v1/stacks/${STACK}/restack`]: { ok: true } });
  const payload = await stackRestack(STACK, cfg);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, `https://api.example.test/api/v1/stacks/${STACK}/restack`);
  assert.match(payload.summary, /Restacked stack/);
  assert.equal((payload.data.watch as { done: boolean }).done, false);
});

test("enqueue from a chat tracks the stack as a background task and says so", async () => {
  const calls = stubFetch({
    [`/api/v1/stacks/${STACK}/enqueue`]: { entry: { id: "e1" } },
    "/api/v1/stacks/chat-waits": { task: { id: "t1", title: "Land the stack on acme/app" } },
  });
  const payload = await stackEnqueue(STACK, cfg, CHAT);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [`/api/v1/stacks/${STACK}/enqueue`, "/api/v1/stacks/chat-waits"]);
  assert.deepEqual(calls[1]!.body, { chat_id: CHAT, kind: "stack", stack_id: STACK });
  assert.ok(payload.summary.endsWith(chatTaskNote({ id: "t1", title: "Land the stack on acme/app" })));
  assert.deepEqual(payload.data.background_task, { id: "t1", title: "Land the stack on acme/app" });
});

test("enqueue outside a chat registers nothing", async () => {
  const calls = stubFetch({ [`/api/v1/stacks/${STACK}/enqueue`]: { entry: { id: "e1" } } });
  const payload = await stackEnqueue(STACK, cfg, null);
  assert.equal(calls.length, 1);
  assert.equal(payload.data.background_task, undefined);
});
