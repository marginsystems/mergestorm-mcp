import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { agentRequest } from "./agent-request.js";

const cfg = { apiKey: "ms_test", apiBase: "https://api.example.test" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  }) as typeof fetch;
  return calls;
}

test("a success answers with the server's message and keeps the body as data", async () => {
  const calls = stubFetch(202, { started: true, message: "Vortex review started." });
  const payload = await agentRequest("/api/v1/agents/vortex/review", { method: "POST", json: { owner: "acme" } }, cfg);
  assert.deepEqual(payload, { summary: "Vortex review started.", data: { started: true, message: "Vortex review started." } });
  assert.equal(calls[0]!.url, "https://api.example.test/api/v1/agents/vortex/review");
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { owner: "acme" });
});

test("a refusal is an error whose summary is the server's refusal text", async () => {
  stubFetch(409, { error: "nothing_to_do", message: "CI is passing. Nothing was started." });
  const payload = await agentRequest("/api/v1/agents/cyclone/jobs", { method: "POST", json: {} }, cfg);
  assert.equal(payload.isError, true);
  assert.equal(payload.summary, "CI is passing. Nothing was started.");
  assert.deepEqual(payload.data.error, { code: "nothing_to_do", message: "CI is passing. Nothing was started." });
});

test("a rate limit carries retry_after_seconds, and a server without the route says so", async () => {
  stubFetch(429, { error: "rate_limited", message: "Slow down." }, { "Retry-After": "12" });
  const limited = await agentRequest("/api/v1/agents/surge/setup", { method: "POST", json: {} }, cfg);
  assert.equal((limited.data.error as { retry_after_seconds?: number }).retry_after_seconds, 12);
  stubFetch(404, "404 Not Found");
  await assert.rejects(agentRequest("/api/v1/agents/surge/setup", { method: "POST", json: {} }, cfg), /does not offer that action yet/);
});
