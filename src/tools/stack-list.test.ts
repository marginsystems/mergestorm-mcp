import { CommandError } from "mergestorm/client";
import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { stackList } from "./stack-list.js";
import { stackStatus } from "./stack-status.js";

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

  test("stack_list returns an empty stack collection", async () => {
    mockFetch(200, { stacks: [] });
    const result = await stackList(cfg);
    assert.equal(result.summary, "No stacks");
    assert.deepEqual(result.data.stacks, []);
  });

  test("stack_list returns owned stack DTOs with factual state summaries", async () => {
    mockFetch(200, {
      stacks: [
        {
          id: "stack-1",
          owner: "acme",
          repo: "widgets",
          layers: [{ state: "clean" }, { state: "needs_restack" }],
        },
      ],
    });
    const result = await stackList(cfg);
    assert.equal(
      result.summary,
      "acme/widgets · 2 layers · restack: clean, needs_restack · auto-land off",
    );
    const stacks = result.data.stacks as Array<{ id: string }>;
    assert.equal(stacks[0]?.id, "stack-1");
  });

  test("stack_list preserves live gate blockers during queue activity", async () => {
    const stack = {
      id: "queued-stack",
      owner: "acme",
      repo: "widgets",
      layers: [{ prNumber: 7, position: 1, state: "clean", draft: true }],
    };
    originalFetch ??= globalThis.fetch;
    globalThis.fetch = async (input) => Response.json(
      String(input).endsWith("/stacks/queue")
        ? { entries: [{ stackId: stack.id, state: "queued" }] }
        : { stacks: [stack] },
    );
    const result = await stackList(cfg);
    assert.match(result.summary, /blocked: #7 Draft PR/);
  });

  test("stack list and status surface queue API failures", async () => {
    originalFetch ??= globalThis.fetch;
    const stack = {
      id: "queue-failed-stack",
      owner: "acme",
      repo: "widgets",
      layers: [{ state: "clean" }],
    };
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/stacks/queue")) return Response.json({ error: "queue_failed" }, { status: 503 });
      return Response.json({ stacks: [stack] });
    };

    await assert.rejects(
      () => stackList(cfg),
      (err: unknown) => err instanceof CommandError &&
        err.message === 'Failed to list merge queue (HTTP 503): {"error":"queue_failed"}',
    );
    await assert.rejects(
      () => stackStatus(stack.id, cfg),
      (err: unknown) => err instanceof CommandError &&
        err.message === 'Failed to list merge queue (HTTP 503): {"error":"queue_failed"}',
    );
  });
});
