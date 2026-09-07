import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CommandError, REVIEW_JOB_ENVELOPE_SCHEMA } from "mergestorm/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMergestormMcpServer } from "../server.js";
import { credits } from "./credits.js";
import { queueStatus } from "./queue-status.js";
import { reviewGet } from "./review-get.js";
import { reviewList } from "./review-list.js";
import { settingsGet } from "./settings-get.js";
import { settingsSet } from "./settings-set.js";
import { stackAdopt, type StackAdoptInput } from "./stack-adopt.js";
import { stackList } from "./stack-list.js";
import { stackSet } from "./stack-set.js";
import { stackStatus } from "./stack-status.js";
import { whoami } from "./whoami.js";

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
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
}

test("whoami returns key prefix and plan without a job envelope", async () => {
  mockFetch(200, meBody);
  const result = await whoami(cfg);
  assert.match(result.summary, /msk_live_te/);
  assert.match(result.summary, /Starter/);
  assert.equal(result.data.key_prefix, "msk_live_te");
  assert.equal(result.data.plan_key, "starter");
  assert.equal(result.data.schema, undefined);
});

test("whoami throws when no API key is configured", async () => {
  originalApiKey = process.env.MERGESTORM_API_KEY;
  delete process.env.MERGESTORM_API_KEY;
  await assert.rejects(
    () => whoami({}),
    (err: unknown) => err instanceof CommandError && err.code === "missing_api_key",
  );
});

test("credits returns monthly and bonus usage with resets_at", async () => {
  mockFetch(200, meBody);
  const result = await credits(cfg);
  assert.equal(result.summary, "3 used · 37 remaining · 9 bonus remaining");
  assert.deepEqual(result.data.usage, meBody.usage);
  assert.equal(result.data.resets_at, meBody.resets_at);
});

test("review_list wraps jobs in the review envelope", async () => {
  mockFetch(200, {
    items: [
      {
        job_id: "job_1",
        thread_slug: "local/feat",
        status: "completed",
        verdict: "approve",
        summary: "ok",
        base_label: "main",
        head_label: "HEAD",
        created_at: "2026-08-24T00:00:00.000Z",
        finished_at: "2026-08-24T00:01:00.000Z",
        credits: { standard: 1 },
      },
    ],
  });
  const result = await reviewList(10, cfg);
  assert.equal(result.summary, "1 review job");
  const items = result.data.items as { schema: string; job_id: string }[];
  assert.equal(items[0]?.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
  assert.equal(items[0]?.job_id, "job_1");
});

test("review_get returns one job envelope", async () => {
  mockFetch(200, {
    job_id: "job_9",
    status: "completed",
    verdict: "request_changes",
    thread_slug: "local/feat",
    summary: "nits",
  });
  const result = await reviewGet("job_9", cfg);
  assert.equal(result.summary, "job_9 · completed · request_changes");
  assert.equal(result.data.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
  assert.equal(result.data.job_id, "job_9");
  assert.equal(result.data.status, "completed");
});

test("review_get returns a structured rate_limited envelope", async () => {
  mockFetch(
    429,
    { error: "rate_limited", retry_after_seconds: 9 },
    { "Retry-After": "9" },
  );
  const result = await reviewGet("job_9", cfg);
  assert.equal(result.data.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
  assert.equal(result.data.job_id, "job_9");
  assert.equal(result.data.status, "rate_limited");
  assert.equal(result.data.retry_after_seconds, 9);
});

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
    "acme/widgets · 2 layers · layers: clean, needs_restack · auto-land off",
  );
  const stacks = result.data.stacks as Array<{ id: string }>;
  assert.equal(stacks[0]?.id, "stack-1");
});

test("stack_status summary includes cycloneOwnerMatch when present", async () => {
  mockFetch(200, {
    stacks: [
      {
        id: "stack-9",
        owner: "acme",
        repo: "widgets",
        layers: [{ state: "clean" }],
        cycloneOwnerMatch: "different",
        keyUserId: "key-user",
        cycloneInstallUserId: "install-user",
      },
    ],
  });
  const result = await stackStatus("stack-9", cfg);
  assert.equal(
    result.summary,
    "acme/widgets · 1 layer · layers: clean · auto-land off · cyclone-owner different",
  );
  const stack = result.data.stack as {
    cycloneOwnerMatch: string;
    keyUserId: string;
    cycloneInstallUserId: string;
  };
  assert.equal(stack.cycloneOwnerMatch, "different");
  assert.equal(stack.keyUserId, "key-user");
  assert.equal(stack.cycloneInstallUserId, "install-user");
});

test("stack_status returns one enriched owned stack", async () => {
  mockFetch(200, {
    stacks: [
      {
        id: "stack-9",
        owner: "acme",
        repo: "widgets",
        layers: [{ state: "clean", checks: { total: 2, success: 2 } }],
      },
    ],
  });
  const result = await stackStatus("stack-9", cfg);
  assert.equal(
    result.summary,
    "acme/widgets · 1 layer · layers: clean · auto-land off",
  );
  assert.equal(result.isError, undefined);
  const stack = result.data.stack as { id: string; layers: Array<{ checks: unknown }> };
  assert.equal(stack.id, "stack-9");
  assert.deepEqual(stack.layers[0]?.checks, { total: 2, success: 2 });
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
  assert.equal(result.summary, "Auto land on for stack stack-9");
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
  assert.equal(result.summary, "auto-review default, auto-patch off for stack stack-9");
  assert.deepEqual(result.data.auto_review, null);
  assert.deepEqual(result.data.auto_patch, false);
  assert.equal("auto_land" in result.data, false);
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

test("stack_status returns a structured not-found error", async () => {
  mockFetch(200, { stacks: [] });
  const result = await stackStatus("not-owned", cfg);
  assert.equal(result.isError, true);
  assert.deepEqual(result.data.error, {
    code: "stack_not_found",
    message: "Stack not found or not owned by the current user: not-owned",
    stack_id: "not-owned",
  });
});

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
  assert.equal(result.summary, "#1 · acme/widgets · stack stack-1 · waiting");
  const entries = result.data.entries as Array<{ id: string }>;
  assert.equal(entries[0]?.id, "queue-1");
});

test("queue_status filters a live entry by stack_id", async () => {
  mockFetch(200, {
    entries: [
      {
        id: "queue-1",
        stackId: "stack-1",
        owner: "acme",
        repo: "widgets",
        state: "queued",
        position: 1,
      },
      {
        id: "queue-2",
        stackId: "stack-2",
        owner: "acme",
        repo: "gadgets",
        state: "running",
        position: 2,
      },
    ],
  });

  const result = await queueStatus("stack-2", cfg);
  assert.equal(result.summary, "#2 · acme/gadgets · stack stack-2 · running");
  assert.equal((result.data.entry as { id: string }).id, "queue-2");
});

test("queue_status returns a structured not-found error for a stack filter", async () => {
  mockFetch(200, { entries: [] });
  const result = await queueStatus("not-queued", cfg);
  assert.equal(result.isError, true);
  assert.deepEqual(result.data.error, {
    code: "queue_entry_not_found",
    message: "Live queue entry not found for stack: not-queued",
    stack_id: "not-queued",
  });
});

const settingsBody = {
  auto_review_enabled: true,
  auto_patch_enabled: false,
  vortex_show_thinking_traces: false,
  repo_overview_enabled: true,
  review_unit_land_prs_enabled: false,
  cyclone_review_unit_land_prs_enabled: false,
  vortex_seam_specialist_enabled: true,
  auto_land_default: false,
  cyclone_connected: true,
  github_connected: true,
};

test("settings_get returns the settings allowlist with an actionable summary", async () => {
  mockFetch(200, settingsBody);
  const result = await settingsGet(cfg);
  assert.equal(result.summary, "auto_patch off · Cyclone connected");
  assert.deepEqual(result.data, settingsBody);
  assert.equal(result.data.auto_patch_enabled, false);
  assert.equal(result.data.cyclone_connected, true);
});

test("settings_get surfaces auto_patch on in the summary", async () => {
  mockFetch(200, {
    ...settingsBody,
    auto_patch_enabled: true,
    cyclone_connected: false,
  });
  const result = await settingsGet(cfg);
  assert.equal(result.summary, "auto_patch on · Cyclone not connected");
});

test("settings_get throws when the settings API is unavailable", async () => {
  mockFetch(404, { error: "not_found" });
  await assert.rejects(
    () => settingsGet(cfg),
    (err: unknown) =>
      err instanceof CommandError && /Settings are not available/.test(err.message),
  );
});

test("settings_set PATCHes only the provided writable keys", async () => {
  originalFetch ??= globalThis.fetch;
  let method = "";
  let requestUrl = "";
  let requestBody: unknown;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    method = init?.method ?? "GET";
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ...settingsBody, auto_patch_enabled: false });
  };

  const result = await settingsSet(
    { auto_patch_enabled: false, vortex_seam_specialist_enabled: undefined },
    cfg,
  );
  assert.equal(requestUrl, "https://api.example.test/api/v1/settings");
  assert.equal(method, "PATCH");
  assert.deepEqual(requestBody, { auto_patch_enabled: false });
  assert.equal(result.summary, "auto_patch off · Cyclone connected");
  assert.equal(result.data.auto_patch_enabled, false);
});

test("settings_set with no keys is a usage error", async () => {
  await assert.rejects(
    () => settingsSet({}, cfg),
    (err: unknown) => err instanceof CommandError && err.code === "usage",
  );
});

test("settings_set rejects read-only keys", async () => {
  for (const key of ["cyclone_connected", "github_connected"]) {
    await assert.rejects(
      () => settingsSet({ [key]: false }, cfg),
      (err: unknown) =>
        err instanceof CommandError &&
        err.code === "usage" &&
        err.message.includes(`${key} is read-only`),
    );
  }
});

test("settings_set rejects non-boolean values as usage errors", async () => {
  await assert.rejects(
    () => settingsSet({ auto_patch_enabled: "off" }, cfg),
    (err: unknown) => err instanceof CommandError && err.code === "usage",
  );
});

test("settings_set PATCHes auto_patch_enabled true", async () => {
  originalFetch ??= globalThis.fetch;
  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ...settingsBody, auto_patch_enabled: true });
  };

  const result = await settingsSet({ auto_patch_enabled: true }, cfg);
  assert.deepEqual(requestBody, { auto_patch_enabled: true });
  assert.equal(result.summary, "auto_patch on · Cyclone connected");
  assert.equal(result.data.auto_patch_enabled, true);
});

test("settings_set PATCHes auto_land_default true", async () => {
  originalFetch ??= globalThis.fetch;
  let method = "";
  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    method = init?.method ?? "GET";
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ ...settingsBody, auto_land_default: true });
  };

  const result = await settingsSet({ auto_land_default: true }, cfg);
  assert.equal(method, "PATCH");
  assert.deepEqual(requestBody, { auto_land_default: true });
  assert.equal(result.data.auto_land_default, true);
});

test("stack read handlers surface API errors", async () => {
  mockFetch(503, { error: "busy" });
  await assert.rejects(
    () => stackList(cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.message === 'Failed to list stacks (HTTP 503): {"error":"busy"}',
  );

  mockFetch(500, { error: "enrich_failed" });
  await assert.rejects(
    () => stackStatus("stack-1", cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.message ===
        'Failed to get stack status (HTTP 500): {"error":"enrich_failed"}',
  );

  mockFetch(502, { error: "queue_failed" });
  await assert.rejects(
    () => queueStatus(undefined, cfg),
    (err: unknown) =>
      err instanceof CommandError &&
      err.message ===
        'Failed to get queue status (HTTP 502): {"error":"queue_failed"}',
  );
});

test("stack read handlers return structured rate_limited payloads", async () => {
  mockFetch(
    429,
    { error: "rate_limited", retry_after_seconds: 9 },
    { "Retry-After": "9" },
  );
  const list = await stackList(cfg);
  assert.equal(list.isError, true);
  const listError = list.data.error as { code?: string; retry_after_seconds?: number };
  assert.equal(listError.code, "rate_limited");
  assert.equal(listError.retry_after_seconds, 9);

  mockFetch(
    429,
    { error: "rate_limited", retry_after_seconds: 6 },
    { "Retry-After": "6" },
  );
  const status = await stackStatus("stack-1", cfg);
  assert.equal(status.isError, true);
  const statusError = status.data.error as { code?: string; retry_after_seconds?: number };
  assert.equal(statusError.code, "rate_limited");
  assert.equal(statusError.retry_after_seconds, 6);

  mockFetch(
    429,
    { error: "rate_limited", retry_after_seconds: 4 },
    { "Retry-After": "4" },
  );
  const queue = await queueStatus(undefined, cfg);
  assert.equal(queue.isError, true);
  const queueError = queue.data.error as { code?: string; retry_after_seconds?: number };
  assert.equal(queueError.code, "rate_limited");
  assert.equal(queueError.retry_after_seconds, 4);
});

for (const failure of ["404", "network", "timeout", "401"] as const) {
  test(`whoami rejects ${failure} instead of returning cached account metadata`, async () => {
    if (failure === "404" || failure === "401") {
      mockFetch(Number(failure), { error: "unavailable" });
    } else {
      originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        if (failure === "timeout") {
          throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        }
        throw new TypeError("fetch failed");
      };
    }
    await assert.rejects(() => whoami(cfg), (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.notEqual(err.exitCode, 0);
      if (failure === "401") assert.equal(err.code, "auth_invalid");
      else assert.match(err.message, /Live account details unavailable/);
      return true;
    });
  });
}

test("MCP whoami returns an error payload when live account details are unavailable", async () => {
  originalApiKey = process.env.MERGESTORM_API_KEY;
  process.env.MERGESTORM_API_KEY = cfg.apiKey;
  mockFetch(404, { error: "not_found" });
  const server = createMergestormMcpServer();
  const client = new Client({ name: "whoami-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.match(JSON.stringify(result.content), /Live account details unavailable/);
    assert.doesNotMatch(JSON.stringify(result), /key_prefix|usage/);
  } finally {
    await client.close();
    await server.close();
  }
});

const adoptPolicies: Array<
  Partial<Pick<StackAdoptInput, "auto_land" | "auto_review" | "auto_patch">>
> = [
  {},
  { auto_land: false, auto_review: null, auto_patch: false },
  { auto_land: false, auto_review: true, auto_patch: null },
  { auto_review: false, auto_patch: null },
];
for (const policy of adoptPolicies) {
  test(`stack_adopt POSTs Bearer adoption with policy ${JSON.stringify(policy)}`, async () => {
    originalFetch ??= globalThis.fetch;
    let calls = 0;
    const body = { stack: { id: "stack-9" }, chain: [] };
    globalThis.fetch = async (input, init) => {
      calls += 1;
      assert.equal(String(input), "https://api.example.test/api/v1/stacks/adopt");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${cfg.apiKey}`);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        owner: "acme", repo: "widgets", prNumber: 42,
        ...("auto_land" in policy ? { autoEnqueueWhenReady: policy.auto_land } : {}),
        ...("auto_review" in policy ? { autoReviewOverride: policy.auto_review } : {}),
        ...("auto_patch" in policy ? { autoPatchOverride: policy.auto_patch } : {}),
      });
      return Response.json(body);
    };
    const result = await stackAdopt({ owner: " acme ", repo: "widgets", pr_number: 42, ...policy }, cfg);
    assert.equal(calls, 1);
    assert.equal(result.isError, undefined);
    assert.equal(result.summary, "Adopted stack for acme/widgets#42");
    assert.deepEqual(result.data.result, body);
  });
}

test("stack_adopt rejects invalid input without calling the API", async () => {
  originalFetch ??= globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  for (const invalid of [
    { repo: "widgets", pr_number: 42 },
    { owner: "acme", pr_number: 42 },
    { owner: "acme", repo: "widgets" },
    ...[{ owner: " " }, { repo: "" }, { pr_number: 0 }, { pr_number: 1.5 },
      { auto_land: null }, { auto_land: true }, { auto_patch: "off" }, { auto_patch: true }].map((override) => ({
        owner: "acme", repo: "widgets", pr_number: 42, ...override,
      })),
  ]) {
    const result = await stackAdopt(invalid as StackAdoptInput, cfg);
    assert.equal(result.isError, true);
    assert.equal((result.data.error as { code: string }).code, "invalid_input");
  }
  assert.equal(calls, 0);
});

test("stack_adopt returns a structured API failure", async () => {
  mockFetch(503, { error: "busy" });
  const result = await stackAdopt({ owner: "acme", repo: "widgets", pr_number: 42 }, cfg);
  assert.equal(result.isError, true);
  assert.match(result.summary, /Failed to import stack.*503/);
  assert.equal((result.data.error as { code: string }).code, "stack_adopt_failed");
});

test("stack_adopt returns rate-limit details from the API", async () => {
  mockFetch(429, { error: "rate_limited", retry_after_seconds: 9 }, { "Retry-After": "9" });
  const result = await stackAdopt({ owner: "acme", repo: "widgets", pr_number: 42 }, cfg);
  const error = result.data.error as { code: string; retry_after_seconds?: number };
  assert.equal(error.code, "rate_limited");
  assert.equal(error.retry_after_seconds, 9);
});

test("MCP stack_adopt rejects missing target fields before calling the API", async () => {
  originalFetch ??= globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  const server = createMergestormMcpServer();
  const client = new Client({ name: "adopt-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const key of ["owner", "repo", "pr_number"]) {
      const args: Record<string, unknown> = { owner: "acme", repo: "widgets", pr_number: 42 };
      delete args[key];
      const result = await client.callTool({ name: "stack_adopt", arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(calls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
