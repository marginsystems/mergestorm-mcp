import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { credits } from "./credits.js";

describe("handlers", { concurrency: false }, () => {

  const cfg = {
    apiKey: "msk_live_test_mcp_key",
    apiBase: "https://api.example.test",
  };

  const meBody = {
    key: {
      prefix: "msk_live_te",
      name: "ci",
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: null,
    },
    plan_key: "starter",
    plan_label_key: "Starter",
    resets_at: "2026-09-01T00:00:00.000Z",
    usage: {
      standard: { used: 3, limit: 40, remaining: 37 },
      bonus: { remaining: 9 },
    },
  };

  let originalFetch: typeof globalThis.fetch | undefined;
  let originalApiKey: string | undefined;

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = undefined;
    }
    if (originalApiKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = originalApiKey;
    originalApiKey = undefined;
  });

  function mockFetch(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    originalFetch ??= globalThis.fetch;
    globalThis.fetch = async (input) =>
      new Response(JSON.stringify(
        String(input).includes("/stacks/queue") && status === 200 && body && typeof body === "object" && "stacks" in body
          ? { entries: [] }
          : body,
      ), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      });
  }

  test("credits returns monthly and bonus usage with resets_at", async () => {
    mockFetch(200, meBody);
    const result = await credits(cfg);
    assert.equal(result.summary, "3 used · 37 remaining · 9 bonus remaining");
    assert.deepEqual(result.data.usage, meBody.usage);
    assert.equal(result.data.resets_at, meBody.resets_at);
  });

  test("credits adds the surge meter to the summary and keeps it in the data", async () => {
    const surge = {
      includedMinutes: 300,
      usedMinutes: 120,
      walletMinutes: 1000,
      windowStart: "2026-08-14T10:20:00.000Z",
      pricePerMinuteUsd: 0.005,
    };
    mockFetch(200, { ...meBody, usage: { ...meBody.usage, surge } });
    const result = await credits(cfg);
    assert.equal(
      result.summary,
      "3 used · 37 remaining · 9 bonus remaining\nSurge: 120 of 300 included min this period · wallet 1,000 min",
    );
    assert.deepEqual((result.data.usage as { surge: unknown }).surge, surge);
  });

  test("credits prints only the wallet for a Surge account without included minutes", async () => {
    const surge = {
      includedMinutes: 0,
      usedMinutes: 0,
      walletMinutes: 500,
      windowStart: "2026-08-14T10:20:00.000Z",
      pricePerMinuteUsd: 0.005,
    };
    mockFetch(200, { ...meBody, usage: { ...meBody.usage, surge } });
    const result = await credits(cfg);
    assert.equal(result.summary, "3 used · 37 remaining · 9 bonus remaining\nSurge: wallet 500 min");
  });
});
