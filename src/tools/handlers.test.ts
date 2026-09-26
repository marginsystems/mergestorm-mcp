import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CommandError, REVIEW_JOB_ENVELOPE_SCHEMA, stackBlockers, type MergeQueueEntryDto, type StackDto } from "mergestorm/client";
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
import { stackSummary } from "./stack-summary.js";
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
    "acme/widgets · 1 layer · restack: clean · auto-land off · cyclone-owner different",
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
    "acme/widgets · 1 layer · restack: clean · auto-land off",
  );
  assert.equal(result.isError, undefined);
  const stack = result.data.stack as { id: string; layers: Array<{ checks: unknown }> };
  assert.equal(stack.id, "stack-9");
  assert.deepEqual(stack.layers[0]?.checks, { total: 2, success: 2 });
});

test("stack_status reads only its own stack queue and returns the wait loop blockers", async () => {
  originalFetch ??= globalThis.fetch;
  const head = "a".repeat(40);
  const stack = {
    id: "stack-9",
    owner: "acme",
    repo: "widgets",
    layers: [
      { prNumber: 7, position: 0, branch: "feature", parentBranch: "main", state: "clean", ciStatus: "success", headSha: head },
      { prNumber: 8, position: 1, branch: "child", parentBranch: "feature", state: "clean", ciStatus: "failure", headSha: "b".repeat(40) },
    ],
  };
  const bounced = {
    id: "bounce-1", stackId: "stack-9", owner: "acme", repo: "widgets", state: "bounced", position: 0,
    bounceReason: "ci_failure", bounceDetail: { kind: "ci_failure", headSha: head, prNumber: 7, failingCheck: "lint" },
    finishedAt: "2026-09-01T00:00:00Z",
  };
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/stacks/queue")) {
      return Response.json({
        entries: url.includes("?stackId=stack-9")
          ? [bounced]
          : Array.from({ length: 10 }, (_, index) => ({ ...bounced, id: `other-${index}`, stackId: "other-stack" })),
      });
    }
    return Response.json({ stacks: [stack] });
  };
  const result = await stackStatus("stack-9", cfg);
  assert.deepEqual(urls.filter((url) => url.includes("/stacks/queue")), [
    "https://api.example.test/api/v1/stacks/queue?stackId=stack-9",
  ]);
  const expected = stackBlockers(stack as unknown as StackDto, [bounced as unknown as MergeQueueEntryDto]);
  assert.deepEqual(result.data, {
    stack,
    attention: expected.attention,
    issues: expected.issues,
    currentCandidate: expected.currentCandidate,
  });
  assert.equal(result.data.attention && (result.data.attention as { blocker: string }).blocker, "CI failed — lint");
  assert.deepEqual(result.data.issues, [{ prNumber: 8, headSha: "b".repeat(40), blocker: "CI failed", bounceKind: null }]);
  assert.deepEqual(result.data.currentCandidate, { prNumber: 7, headSha: head });
  assert.match(result.summary, /blocked: #7 CI failed — lint · issues: #8 CI failed$/);
});

test("stack_status maps a queue 429 to rate_limited with retry_after_seconds", async () => {
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("/stacks/queue")
    ? new Response("{}", { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "17" } })
    : Response.json({ stacks: [{ id: "stack-9", owner: "acme", repo: "widgets", layers: [] }] });
  const result = await stackStatus("stack-9", cfg);
  assert.equal(result.isError, true);
  const error = result.data.error as { code: string; retry_after_seconds: number };
  assert.equal(error.code, "rate_limited");
  assert.equal(error.retry_after_seconds, 17);
});

test("stack_status matches the stack id case-insensitively like stack_wait", async () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  mockFetch(200, { stacks: [{ id, owner: "acme", repo: "widgets", layers: [{ state: "clean" }] }] });
  const result = await stackStatus(id.toUpperCase(), cfg);
  assert.equal(result.isError, undefined);
  assert.equal((result.data.stack as { id: string }).id, id);
  assert.equal(result.data.attention, null);
  assert.deepEqual(result.data.issues, []);
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

const settingsBody = {
  ignored_bot_logins: ["renovate"],
  vortex_bot_skip_check: "none",
  vortex_findings_check: "neutral",
  cyclone_patch_failure_check: "failure",
  auto_review_enabled: true,
  auto_patch_enabled: false,
  vortex_show_thinking_traces: false,
  repo_overview_enabled: true,
  review_unit_land_prs_enabled: false,
  cyclone_review_unit_land_prs_enabled: false,
  cyclone_skip_ci_enabled: true,
  cyclone_patch_unverified_languages: false,
  vortex_seam_specialist_enabled: true,
  auto_land_default: false,
  auto_land_settle_seconds: 60,
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
  const rows: ReadonlyArray<{
    input: Record<string, unknown>;
    body: Record<string, boolean>;
    summary?: string;
  }> = [
    {
      input: { auto_patch_enabled: false, vortex_seam_specialist_enabled: undefined },
      body: { auto_patch_enabled: false },
      summary: "auto_patch off · Cyclone connected",
    },
    {
      input: { auto_patch_enabled: true },
      body: { auto_patch_enabled: true },
      summary: "auto_patch on · Cyclone connected",
    },
    {
      input: { cyclone_skip_ci_enabled: false },
      body: { cyclone_skip_ci_enabled: false },
    },
    {
      input: { cyclone_patch_unverified_languages: true },
      body: { cyclone_patch_unverified_languages: true },
    },
    {
      input: { auto_land_default: true },
      body: { auto_land_default: true },
    },
  ];

  for (const row of rows) {
    originalFetch ??= globalThis.fetch;
    let method = "";
    let requestUrl = "";
    let requestBody: unknown;
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      method = init?.method ?? "GET";
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ ...settingsBody, ...row.body });
    };

    const result = await settingsSet({ ...row.input }, cfg);
    assert.equal(method, "PATCH");
    assert.deepEqual(requestBody, row.body);
    for (const [key, value] of Object.entries(row.body)) {
      assert.equal(result.data[key], value);
    }
    if ("auto_patch_enabled" in row.body) {
      assert.equal(requestUrl, "https://api.example.test/api/v1/settings");
      assert.equal(result.summary, row.summary);
    }
  }
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

test("settings_set rejects non-boolean values for boolean keys as usage errors", async () => {
  await assert.rejects(
    () => settingsSet({ auto_patch_enabled: "off" }, cfg),
    (err: unknown) => err instanceof CommandError && err.code === "usage",
  );
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
  { auto_land: true },
  { auto_land: false, auto_review: true, auto_patch: null },
  { auto_patch: true },
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
      { auto_land: null }, { auto_patch: "off" }].map((override) => ({
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
  assert.equal((result.data.error as { code: string }).code, "busy");
});

test("stack_adopt surfaces the Cyclone installation sentence and code", async () => {
  mockFetch(400, {
    error: "cyclone_not_installed",
    message: "Install Cyclone on this repository, then adopt. Cyclone is required for stacks.",
  });
  const result = await stackAdopt({ owner: "acme", repo: "widgets", pr_number: 42 }, cfg);
  assert.equal(result.isError, true);
  assert.equal(
    result.summary,
    "Install Cyclone on this repository, then adopt. Cyclone is required for stacks.",
  );
  assert.equal((result.data.error as { code: string }).code, "cyclone_not_installed");
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

for (const patch of [
  { vortex_findings_check: "failure" },
  { ignored_bot_logins: ["renovate"] },
]) {
  test(`settings_set PATCHes ${JSON.stringify(patch)}`, async () => {
    originalFetch ??= globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.method, "PATCH");
      assert.deepEqual(JSON.parse(String(init?.body)), patch);
      return Response.json({ ...settingsBody, ...patch });
    };
    const result = await settingsSet(patch, cfg);
    assert.deepEqual(result.data, { ...settingsBody, ...patch });
  });
}

test("settings_set rejects wrong list and enum types", async () => {
  for (const patch of [{ ignored_bot_logins: "renovate" }, { ignored_bot_logins: [4] }, { vortex_findings_check: "none" }, { vortex_bot_skip_check: true }]) {
    await assert.rejects(() => settingsSet(patch, cfg), (e: unknown) => e instanceof CommandError && e.code === "usage");
  }
});

test("settings_set PATCHes auto_land_settle_seconds and rejects values outside 15 through 300", async () => {
  originalFetch ??= globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    assert.deepEqual(JSON.parse(String(init?.body)), { auto_land_settle_seconds: 30 });
    return Response.json({ ...settingsBody, auto_land_settle_seconds: 30 });
  };
  const result = await settingsSet({ auto_land_settle_seconds: 30 }, cfg);
  assert.equal(result.data.auto_land_settle_seconds, 30);
  for (const value of [14, 301, 30.5, "30", true]) {
    await assert.rejects(
      () => settingsSet({ auto_land_settle_seconds: value }, cfg),
      (e: unknown) => e instanceof CommandError && e.code === "usage" && /15 through 300/.test(e.message),
    );
  }
  assert.equal(calls, 1);
});

test("MCP settings_set schema accepts auto_land_settle_seconds over transport and bounds it", async () => {
  originalApiKey = process.env.MERGESTORM_API_KEY;
  process.env.MERGESTORM_API_KEY = cfg.apiKey;
  originalFetch ??= globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    assert.deepEqual(JSON.parse(String(init?.body)), { auto_land_settle_seconds: 30 });
    return Response.json({ ...settingsBody, auto_land_settle_seconds: 30 });
  };
  const server = createMergestormMcpServer();
  const client = new Client({ name: "settings-settle-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "settings_set", arguments: { auto_land_settle_seconds: 30 } });
    assert.ok(!result.isError);
    assert.equal((result.structuredContent as Record<string, unknown>).auto_land_settle_seconds, 30);
    for (const value of [14, 301]) {
      const rejected = await client.callTool({ name: "settings_set", arguments: { auto_land_settle_seconds: value } });
      assert.equal(rejected.isError, true);
    }
    assert.equal(calls, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP settings_set schema accepts lists and enums over transport", async () => {
  originalApiKey = process.env.MERGESTORM_API_KEY;
  process.env.MERGESTORM_API_KEY = cfg.apiKey;
  originalFetch ??= globalThis.fetch;
  const patch = { ignored_bot_logins: ["renovate"], vortex_findings_check: "failure", vortex_bot_skip_check: "neutral", cyclone_patch_failure_check: "neutral" };
  globalThis.fetch = async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), patch);
    return Response.json({ ...settingsBody, ...patch });
  };
  const server = createMergestormMcpServer();
  const client = new Client({ name: "settings-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "settings_set", arguments: patch });
    assert.ok(!result.isError);
    assert.deepEqual(result.structuredContent, { ...settingsBody, ...patch });
    for (const key of ["cyclone_connected", "github_connected"]) {
      const rejected = await client.callTool({ name: "settings_set", arguments: { ...patch, [key]: true } });
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected.content), /read-only/);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("stack_status appends the shared CI blocker label and preserves summary fields", async () => {
  mockFetch(200, { stacks: [{
    id: "blocked-stack", owner: "acme", repo: "widgets",
    autoEnqueueWhenReady: true, autoReviewOverride: false,
    layers: [{ prNumber: 7, position: 1, state: "clean", ciStatus: "failure",
      checks: { failure: 1, failingName: "unit tests" } }],
  }] });
  const result = await stackStatus("blocked-stack", cfg);
  assert.equal(result.summary,
    "acme/widgets · 1 layer · restack: clean · auto-land on · auto-review off · blocked: #7 CI failed — unit tests");
});

for (const scenario of ["current", "new head", "requeued", "different PR", "closed", "no SHA", "newer bounce"] as const) {
  test(`stack_status CI bounce summary: ${scenario}`, async () => {
    const stack = {
      id: "bounced-stack", owner: "acme", repo: "widgets",
      layers: [{ prNumber: 7, position: 1, state: scenario === "closed" ? "closed" : "clean",
        headSha: scenario === "new head" ? "b".repeat(40) : "a".repeat(40), ciStatus: "success" }],
    };
    const bounce = {
      stackId: stack.id, state: "bounced", finishedAt: "2026-09-19T00:00:00Z",
      bounceDetail: { kind: "ci_failure", prNumber: scenario === "different PR" ? 8 : 7,
        headSha: scenario === "no SHA" ? undefined : "aaaaaaa", failingCheck: "unit tests" },
    };
    const entries: unknown[] = [bounce];
    if (scenario === "requeued") entries.push({ stackId: stack.id, state: "queued" });
    if (scenario === "newer bounce") entries.push({ ...bounce,
      finishedAt: "2026-09-19T01:00:00Z", bounceDetail: { kind: "head_moved" } });
    originalFetch ??= globalThis.fetch;
    globalThis.fetch = async (input) => Response.json(
      String(input).includes("/stacks/queue?stackId=bounced-stack") ? { entries } : { stacks: [stack] },
    );
    const result = await stackStatus(stack.id, cfg);
    if (scenario === "current") assert.match(result.summary, /blocked: #7 CI failed — unit tests$/);
    else assert.doesNotMatch(result.summary, /blocked:/);
  });
}

test("stack_status selects the unpromoted blocker or the unit land PR", async () => {
  for (const promotedHeadSha of [null, "old-head"]) {
    mockFetch(200, { stacks: [{
      id: "unit-stack", owner: "acme", repo: "widgets",
      layers: [{ prNumber: 7, position: 1, state: "clean", ciStatus: "failure",
        checks: { failingName: "member tests" } }],
      unit: { state: "growing", landPrNumber: 99,
        members: [{ prNumber: 7, promotedHeadSha }],
        landPr: { prNumber: 99, state: "clean", ciStatus: "failure",
          checks: { failingName: "land tests" } } },
    }] });
    const result = await stackStatus("unit-stack", cfg);
    assert.match(result.summary, new RegExp(`blocked: #${promotedHeadSha ? 99 : 7} CI failed — ${promotedHeadSha ? "land" : "member"} tests`));
  }
});

test("stack_status reports a unit land gate blocker", async () => {
  mockFetch(200, { stacks: [{
    id: "unit-gated-stack", owner: "acme", repo: "widgets", layers: [],
    unit: {
      state: "growing", landPrNumber: 99,
      tempestLandStatus: "failed", landingBlockReason: "tempest_failed on land PR #99",
      members: [], landPr: { prNumber: 99, state: "clean" },
    },
  }] });
  const result = await stackStatus("unit-gated-stack", cfg);
  assert.match(result.summary, /blocked: #99 tempest_failed on land PR #99$/);
});

test("stack_status never lets a recoverable bounce suppress current-head project CI failure", async () => {
  const stack = {
    id: "moved-stack", owner: "acme", repo: "widgets",
    autoEnqueueWhenReady: true,
    layers: [{ prNumber: 7, position: 1, state: "clean", headSha: "a".repeat(40),
      ciStatus: "failure", checks: { failure: 1, failingName: "old tests" } }],
  };
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = async (input) => Response.json(
    String(input).includes("/stacks/queue?stackId=")
      ? { entries: [{ stackId: stack.id, state: "bounced", finishedAt: "2026-09-19T00:00:00Z",
          bounceDetail: { kind: "head_moved", prNumber: 7, headSha: "a".repeat(40) } }] }
      : { stacks: [stack] },
  );
  const result = await stackStatus(stack.id, cfg);
  assert.match(result.summary, /blocked: #7 CI failed — old tests/);
});

test("stack_status only uses the selected layer for bounce blockers", () => {
  const summary = stackSummary({
    id: "higher-bounce-stack", owner: "acme", repo: "widgets", layers: [
      { prNumber: 7, position: 1, state: "clean", headSha: "a".repeat(40), ciStatus: "failure",
        checks: { failure: 1, failingName: "old tests" } },
      { prNumber: 8, position: 2, state: "clean", headSha: "b".repeat(40) },
    ],
  } as Parameters<typeof stackSummary>[0], [{
    stackId: "higher-bounce-stack", state: "bounced",
    bounceDetail: { kind: "head_moved", prNumber: 8, headSha: "b".repeat(40) },
  }] as Parameters<typeof stackSummary>[1]);
  assert.match(summary, /blocked: #7 CI failed — old tests$/);
});

test("stack_status skips placeholder layers when selecting a blocker", () => {
  const summary = stackSummary({
    id: "placeholder-stack", owner: "acme", repo: "widgets",
    trunkBranch: "main", landTarget: "main", archivedAt: null,
    layers: [
      { prNumber: 0, position: 1, state: "clean", restackError: { kind: "rebase_conflict" } },
      { prNumber: 7, position: 2, state: "clean" },
    ],
  } as Parameters<typeof stackSummary>[0]);
  assert.doesNotMatch(summary, /blocked:/);
});

test("stack_status does not match a bounce against a placeholder layer", () => {
  const summary = stackSummary({
    id: "placeholder-bounce-stack", owner: "acme", repo: "widgets",
    trunkBranch: "main", landTarget: "main", archivedAt: null,
    layers: [],
    unit: { landPr: { prNumber: 0, state: "clean", headSha: "a".repeat(40) } },
  } as unknown as Parameters<typeof stackSummary>[0], [{
    stackId: "placeholder-bounce-stack", state: "bounced",
    bounceDetail: { kind: "ci_failure", prNumber: 0, headSha: "a".repeat(40) },
  }] as Parameters<typeof stackSummary>[1]);
  assert.doesNotMatch(summary, /blocked:/);
});

for (const [detail, label] of [
  [{ draft: true }, "Draft PR"],
  [{ state: "conflict" }, "Conflict"],
  [{ mergeable: false, mergeableHeadSha: "aaaaaaa" }, "Merge conflicts"],
  [{ agentRuns: [{ agent: "tempest", status: "findings", sha: "aaaaaaa" }] }, "Tempest findings"],
] as const) {
  test(`stack_status names a hard blocker: ${label}`, async () => {
    mockFetch(200, { stacks: [{
      id: "blocked-stack", owner: "acme", repo: "widgets",
      layers: [{ prNumber: 7, position: 1, state: "clean", headSha: "aaaaaaa", ...detail }],
    }] });
    const result = await stackStatus("blocked-stack", cfg);
    assert.ok(result.summary.endsWith(`blocked: #7 ${label}`));
  });
}
