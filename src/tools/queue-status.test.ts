import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { queueStatus } from "./queue-status.js";

describe("handlers", { concurrency: false }, () => {

  const cfg = {
    apiKey: "msk_live_test_mcp_key",
    apiBase: "https://api.example.test",
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

  test("queue_status lists live entries over the Bearer queue endpoint", async () => {
    originalFetch ??= globalThis.fetch;
    let requestUrl = "";
    let authorization = "";
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return Response.json({
        entries: [
          {
            id: "queue-1",
            stackId: "stack-1",
            owner: "acme",
            repo: "widgets",
            state: "waiting",
            position: 1,
          },
        ],
      });
    };

    const result = await queueStatus(undefined, cfg);
    assert.equal(requestUrl, "https://api.example.test/api/v1/stacks/queue");
    assert.equal(authorization, `Bearer ${cfg.apiKey}`);
    assert.equal(result.summary, "waiting · acme/widgets · stack stack-1");
    const entries = result.data.entries as Array<{ id: string }>;
    assert.equal(entries[0]?.id, "queue-1");
  });

  test("queue_status describes bounced entries with kind and head sha", async () => {
    mockFetch(200, {
      entries: [
        {
          id: "queue-bounced",
          stackId: "stack-1",
          owner: "acme",
          repo: "widgets",
          state: "bounced",
          position: 0,
          waitReason: null,
          bounceReason: "ci_failure",
          bounceDetail: {
            kind: "ci_failure",
            prNumber: 42,
            headSha: "abcdef1234567890",
          },
          verifyHeadSha: null,
        },
      ],
    });

    const result = await queueStatus(undefined, cfg);
    assert.equal(
      result.summary,
      "bounced · acme/widgets#42 · stack stack-1 · ci_failure · abcdef1",
    );
  });

  test("queue_status filters all live and bounced entries by stack_id", async () => {
    mockFetch(200, {
      entries: [
        {
          id: "queue-1",
          stackId: "stack-1",
          owner: "acme",
          repo: "widgets",
          state: "queued",
          position: 1,
          waitReason: "awaiting_checks",
          bounceReason: null,
          bounceDetail: null,
          verifyHeadSha: "1234567890abcdef",
        },
        {
          id: "queue-bounced",
          stackId: "stack-1",
          owner: "acme",
          repo: "widgets",
          state: "bounced",
          position: 0,
          waitReason: null,
          bounceReason: "ci_failure",
          bounceDetail: {
            kind: "ci_failure",
            prNumber: 42,
            headSha: "abcdef1234567890",
          },
          verifyHeadSha: null,
        },
        {
          id: "queue-other-stack",
          stackId: "stack-2",
          owner: "acme",
          repo: "widgets",
          state: "queued",
          position: 2,
          waitReason: "awaiting_checks",
          bounceReason: null,
          bounceDetail: null,
          verifyHeadSha: "fedcba9876543210",
        },
      ],
    });

    const result = await queueStatus("stack-1", cfg);
    assert.equal(
      result.summary,
      "queued · acme/widgets · stack stack-1 · awaiting_checks · 1234567\n" +
        "bounced · acme/widgets#42 · stack stack-1 · ci_failure · abcdef1",
    );
    const entries = result.data.entries as Array<{ id: string }>;
    assert.deepEqual(entries.map((entry) => entry.id), ["queue-1", "queue-bounced"]);
    assert.doesNotMatch(result.summary, /stack-2/);
  });

  test("queue_status scopes stack lookups before the capped bounced history read", async () => {
    originalFetch ??= globalThis.fetch;
    let requestUrl = "";
    globalThis.fetch = async (input) => {
      requestUrl = String(input);
      const scoped = requestUrl.includes("?stackId=stack-1");
      return Response.json({
        entries: scoped
          ? [{
              id: "queue-bounced",
              stackId: "stack-1",
              owner: "acme",
              repo: "widgets",
              state: "bounced",
              bounceReason: "ci_failure",
            }]
          : Array.from({ length: 10 }, (_, index) => ({
              id: `other-${index}`,
              stackId: "other-stack",
              owner: "acme",
              repo: "widgets",
              state: "bounced",
            })),
      });
    };

    const result = await queueStatus("stack-1", cfg);
    assert.equal(requestUrl, "https://api.example.test/api/v1/stacks/queue?stackId=stack-1");
    assert.equal(result.isError, undefined);
    assert.equal((result.data.entries as Array<{ id: string }>)[0]?.id, "queue-bounced");
  });

  test("queue_status matches UUID stack filters case-insensitively", async () => {
    mockFetch(200, {
      entries: [
        {
          id: "queue-uuid",
          stackId: "123e4567-e89b-12d3-a456-426614174000",
          owner: "acme",
          repo: "widgets",
          state: "queued",
          position: 1,
          waitReason: "awaiting_checks",
          bounceReason: null,
          bounceDetail: null,
          verifyHeadSha: "1234567890abcdef",
        },
      ],
    });

    const result = await queueStatus("123E4567-E89B-12D3-A456-426614174000", cfg);
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      (result.data.entries as Array<{ id: string }>).map((entry) => entry.id),
      ["queue-uuid"],
    );
  });

  test("queue_status describes an empty queue as neither live nor bounced", async () => {
    mockFetch(200, { entries: [] });
    const result = await queueStatus(undefined, cfg);
    assert.equal(result.isError, undefined);
    assert.equal(result.summary, "No merge queue entries (live or bounced)");
    assert.deepEqual(result.data.entries, []);
  });

  test("queue_status returns a structured not-found error for a stack filter", async () => {
    mockFetch(200, { entries: [] });
    const result = await queueStatus("not-queued", cfg);
    assert.equal(result.isError, true);
    assert.deepEqual(result.data.error, {
      code: "queue_entry_not_found",
      message: "Queue entry not found for stack: not-queued",
      stack_id: "not-queued",
    });
    assert.doesNotMatch((result.data.error as { message: string }).message, /Live/);
  });
});
