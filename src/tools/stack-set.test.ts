import { STACK_WATCH_NOT_DONE_SENTENCE,stackWatchObligation } from "mergestorm/client";
import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { stackSet } from "./stack-set.js";

describe("handlers", { concurrency: false }, () => {
  function stackBody(summary: string): string {
    const [watchText, ...rest] = summary.split("\n\n");
    assert.ok(watchText!.startsWith(STACK_WATCH_NOT_DONE_SENTENCE), watchText);
    return rest.join("\n\n");
  }

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

  test("stack_set PATCHes Auto land on the owned stack", async () => {
    originalFetch ??= globalThis.fetch;
    let requestUrl = "";
    let requestMethod = "";
    let requestBody: unknown;
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestMethod = init?.method ?? "GET";
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ autoEnqueueWhenReady: true });
    };
    const result = await stackSet("stack-9", { auto_land: true }, cfg);
    assert.equal(requestUrl, "https://api.example.test/api/v1/stacks/stack-9");
    assert.equal(requestMethod, "PATCH");
    assert.deepEqual(requestBody, { autoEnqueueWhenReady: true });
    assert.equal(stackBody(result.summary), "Auto land on for stack stack-9");
    assert.deepEqual(result.data.watch, stackWatchObligation({ stackId: "stack-9", terminal: null, unread: true, freshCursor: true }));
  });

  test("stack_set PATCHes the per-stack review / patch overrides, null clearing one", async () => {
    originalFetch ??= globalThis.fetch;
    let requestBody: unknown;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ autoReviewOverride: null, autoPatchOverride: false });
    };
    const result = await stackSet(
      "stack-9",
      { auto_review: null, auto_patch: false },
      cfg,
    );
    assert.deepEqual(requestBody, { autoReviewOverride: null, autoPatchOverride: false });
    assert.equal(result.isError, undefined);
    assert.equal(stackBody(result.summary), "auto-review default, auto-patch off for stack stack-9");
    assert.deepEqual(result.data.auto_review, null);
    assert.deepEqual(result.data.auto_patch, false);
    assert.equal("auto_land" in result.data, false);
  });

  test("stack_set sends auto_resolve_conflicts and auto_fix_ci overrides", async () => {
    originalFetch ??= globalThis.fetch;
    let requestBody: unknown;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ autoResolveConflictsOverride: true, autoFixCiOverride: null });
    };
    const result = await stackSet(
      "stack-9",
      { auto_resolve_conflicts: true, auto_fix_ci: null },
      cfg,
    );
    assert.deepEqual(requestBody, { autoResolveConflictsOverride: true, autoFixCiOverride: null });
    assert.equal(result.isError, undefined);
    assert.equal(stackBody(result.summary), "auto-resolve-conflicts on, auto-fix-ci default for stack stack-9");
    assert.deepEqual(result.data.auto_resolve_conflicts, true);
    assert.deepEqual(result.data.auto_fix_ci, null);
  });

  test("stack_set with no policy key is a structured error and never calls the API", async () => {
    originalFetch ??= globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({});
    };
    const result = await stackSet("stack-9", {}, cfg);
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
    assert.equal((result.data.error as { code: string }).code, "invalid_input");
  });
});
