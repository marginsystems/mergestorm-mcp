import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { surgeSetup } from "./surge-setup.js";

const cfg = { apiKey: "ms_test", apiBase: "https://api.example.test" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("Surge setup posts the repository and answers with the server's reply", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, serve: "served", pr_url: "https://github.com/acme/app/pull/9", message: "Surge now serves acme/app." }), { status: 200 });
  }) as typeof fetch;
  const payload = await surgeSetup({ owner: "acme", repo: "app" }, cfg);
  assert.deepEqual(calls, [{ url: "https://api.example.test/api/v1/agents/surge/setup", body: { owner: "acme", repo: "app" } }]);
  assert.equal(payload.summary, "Surge now serves acme/app.");
  assert.equal(payload.data.pr_url, "https://github.com/acme/app/pull/9");
});
