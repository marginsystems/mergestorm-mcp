import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError, type MemoryItem } from "mergestorm/client";
import { createMemoryToolHandlers, memoryLine, type MemoryApi } from "./memory.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test", ignoreEnv: true };
const ID = "00000000-0000-4000-8000-000000000001";
const CHAT = "6a1f0000-0000-4000-8000-000000000001";

const memory = (fields: Partial<MemoryItem> = {}): MemoryItem => ({
  id: ID, scope: "user", repo: null, kind: "fact", text: "Ships on Fridays", source: "breeze", source_url: null,
  created_at: "2026-10-26T00:00:00.000Z", updated_at: "2026-10-26T00:00:00.000Z", ...fields,
});

function fakeApi(overrides: Partial<MemoryApi> = {}) {
  const calls: unknown[] = [];
  const api: MemoryApi = {
    listMemories: async (filter, cfg) => { calls.push(["list", filter, cfg]); return { memory_mode: "all", items: [memory()] }; },
    searchMemories: async (input) => { calls.push(["search", input]); return { memory_mode: "all", rules: [memory({ scope: "repo", repo: "acme/web", kind: "rule", text: "Use pnpm" })], items: [memory()], total: 2 }; },
    saveMemory: async (input) => { calls.push(["save", input]); return { id: ID, merged: false }; },
    updateMemory: async (id, change) => { calls.push(["update", id, change]); return { id, text: change.text }; },
    deleteMemory: async (id) => { calls.push(["delete", id]); return { id, deleted: true }; },
    getMemoryMode: async () => { calls.push(["get"]); return { memory_mode: "on_request" }; },
    setMemoryMode: async (mode) => { calls.push(["set", mode]); return { memory_mode: mode }; },
    ...overrides,
  };
  return { api, calls };
}

test("memoryLine shows the id, kind and repository", () => {
  assert.equal(memoryLine(memory({ scope: "repo", repo: "acme/web", kind: "rule", text: "Use pnpm" })), `- [${ID}] (rule, acme/web) Use pnpm`);
});

test("remember and search carry the Breeze chat id; list, update, forget and mode call their routes", async () => {
  const { api, calls } = fakeApi();
  const tools = createMemoryToolHandlers(CFG, CHAT, api);
  assert.equal((await tools.remember({ text: "Use pnpm", kind: "rule", repo: "acme/web" })).summary, `Saved to memory as ${ID}.`);
  await tools.remember({ text: "Use npm", kind: "rule", keep_both: true });
  const found = await tools.search({ query: "package manager", repo: "acme/web" });
  assert.equal(found.summary, ["Memories that match, best first:", `- [${ID}] (rule, acme/web) Use pnpm`, `- [${ID}] (fact) Ships on Fridays`].join("\n"));
  assert.equal((await tools.list({ kind: "fact" })).summary, `Memory is all. 1 memory.\n- [${ID}] (fact) Ships on Fridays`);
  assert.equal((await tools.update({ id: ID, text: "Ships on Mondays", kind: "preference" })).summary, `Memory ${ID} updated.`);
  assert.equal((await tools.forget({ id: ID })).summary, `Memory ${ID} forgotten.`);
  assert.equal((await tools.getMode()).summary, "Memory is on_request.");
  assert.equal((await tools.setMode({ memory_mode: "off" })).summary, "Memory is now off.");
  assert.deepEqual(calls, [
    ["save", { text: "Use pnpm", kind: "rule", repo: "acme/web", chatId: CHAT }],
    ["save", { text: "Use npm", kind: "rule", chatId: CHAT, keepBoth: true }],
    ["search", { query: "package manager", repo: "acme/web", chatId: CHAT }],
    ["list", { kind: "fact" }, CFG],
    ["update", ID, { text: "Ships on Mondays", kind: "preference" }],
    ["delete", ID],
    ["get"],
    ["set", "off"],
  ]);
});

test("search says when memory is off and when nothing matches", async () => {
  const off = createMemoryToolHandlers(CFG, null, fakeApi({ searchMemories: async () => ({ memory_mode: "off", rules: [], items: [], total: 0 }) }).api);
  assert.equal((await off.search({ query: "x" })).summary, "Memory is off, so nothing was searched.");
  const empty = createMemoryToolHandlers(CFG, null, fakeApi({ searchMemories: async () => ({ memory_mode: "all", rules: [], items: [], total: 0 }) }).api);
  assert.equal((await empty.search({ query: "x" })).summary, "Nothing in memory matches.");
});

test("a refusal comes back as a tool error with its code", async () => {
  const tools = createMemoryToolHandlers(CFG, null, fakeApi({
    saveMemory: async () => { throw new CommandError("Memory is off, so nothing was saved.", 1, "memory_off"); },
    deleteMemory: async () => { throw new CommandError("Slow down", 7, "rate_limited", { retryAfterSeconds: 9 }); },
  }).api);
  assert.deepEqual(await tools.remember({ text: "x", kind: "fact" }), {
    summary: "Memory is off, so nothing was saved.",
    data: { error: { code: "memory_off", message: "Memory is off, so nothing was saved." } },
    isError: true,
  });
  assert.deepEqual((await tools.forget({ id: ID })).data, { error: { code: "rate_limited", message: "Slow down", retry_after_seconds: 9 } });
});
