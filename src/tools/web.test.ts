import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "mergestorm/client";
import { createWebToolHandlers, type WebApi } from "./web.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test", ignoreEnv: true };

test("web_search and read_web_page return the page text once, with a small data payload", async () => {
  const calls: unknown[] = [];
  const api: WebApi = {
    searchWeb: async (input, cfg) => { calls.push(["search", input, cfg]); return { text: "Search results for \"node\":" }; },
    readWebPage: async (url, cfg) => { calls.push(["read", url, cfg]); return { text: "Title: Node 24" }; },
  };
  const tools = createWebToolHandlers(CFG, api);
  assert.deepEqual(await tools.search({ query: "node", kind: "news" }), { summary: "Search results for \"node\":", data: { query: "node" } });
  assert.deepEqual(await tools.read({ url: "https://nodejs.org/" }), { summary: "Title: Node 24", data: { url: "https://nodejs.org/" } });
  assert.deepEqual(calls, [["search", { query: "node", kind: "news" }, CFG], ["read", "https://nodejs.org/", CFG]]);
});

test("a failed call is a tool error with its code and retry time", async () => {
  const api: WebApi = {
    searchWeb: async () => { throw new CommandError("Too many requests.", 1, "rate_limited", { retryAfterSeconds: 90 }); },
    readWebPage: async () => { throw new Error("socket closed"); },
  };
  const tools = createWebToolHandlers(CFG, api);
  assert.deepEqual(await tools.search({ query: "node" }), { summary: "Too many requests.", data: { error: { code: "rate_limited", message: "Too many requests.", retry_after_seconds: 90 } }, isError: true });
  assert.deepEqual(await tools.read({ url: "https://nodejs.org/" }), { summary: "socket closed", data: { error: { code: "web_failed", message: "socket closed" } }, isError: true });
});
