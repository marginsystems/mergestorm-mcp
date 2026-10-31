import type { MergeQueueEntryDto,StackDto } from "mergestorm/client";
import { CommandError,STACK_WATCH_NOT_DONE_SENTENCE,stackBlockers,stackWatchObligation } from "mergestorm/client";
import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { queueStatus } from "./queue-status.js";
import { stackList } from "./stack-list.js";
import { stackStatus } from "./stack-status.js";
import { stackSummary } from "./stack-summary.js";

describe("handlers", { concurrency: false }, () => {
  function stackBody(summary: string): string {
    const [watchText, ...rest] = summary.split("\n\n");
    assert.ok(watchText!.startsWith(STACK_WATCH_NOT_DONE_SENTENCE), watchText);
    return rest.join("\n\n");
  }

  function statusLine(summary: string): string {
    return stackBody(summary).split("\n")[0]!;
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
      statusLine(result.summary),
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
      statusLine(result.summary),
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
      held: expected.held,
      busy: expected.busy,
      agents: expected.agents,
      repair: expected.repair,
      landGatePending: null,
      queueWait: expected.queueWait,
      watch: stackWatchObligation({ stackId: "stack-9", terminal: null, cursor: { enrolledHeadSha: head }, freshCursor: true,
        attention: { prNumber: 7, blocker: "CI failed — lint" } }),
    });
    assert.equal((result.data.repair as { kind: string }).kind, "ci_failure");
    assert.match(result.summary, /^This stack is not landed\. Your task is not done\. Call stack_wait again with this cursor\./);
    assert.equal(result.data.attention && (result.data.attention as { blocker: string }).blocker, "CI failed — lint");
    assert.deepEqual(result.data.issues, [{ prNumber: 8, headSha: "b".repeat(40), blocker: "CI failed", bounceKind: null }]);
    assert.deepEqual(result.data.currentCandidate, { prNumber: 7, headSha: head });
    assert.match(statusLine(result.summary), /blocked: #7 CI failed — lint · issues: #8 CI failed$/);
  });

  test("stack_status reports a landed stack as done and drops the obligation", async () => {
    originalFetch ??= globalThis.fetch;
    globalThis.fetch = async (input) => String(input).includes("/stacks/queue")
      ? Response.json({ entries: [] })
      : Response.json({ stacks: [{
        id: "stack-9", owner: "acme", repo: "widgets", trunkBranch: "mg-stack-4", archivedAt: null,
        layers: [{ prNumber: 7, position: 1, branch: "feature", state: "merged" }],
        unit: { id: "u", uNumber: 4, state: "landed", branch: "mg-stack-4", landTarget: "main", members: [],
          landPrNumber: 90, landingBlockReason: null, landPr: null },
      }] });
    const result = await stackStatus("stack-9", cfg);
    const watch = result.data.watch as { done: boolean; reason: string; next: unknown };
    assert.deepEqual({ done: watch.done, reason: watch.reason, next: watch.next }, { done: true, reason: "landed", next: null });
    assert.ok(result.summary.startsWith("This stack is landed. The watch is done"));
    assert.doesNotMatch(result.summary, /Your task is not done/);
  });

  test("stack_status on an archived stack is done: archived", async () => {
    mockFetch(200, { stacks: [{ id: "stack-9", owner: "acme", repo: "widgets", archivedAt: "2026-09-28T00:00:00Z",
      layers: [{ prNumber: 7, position: 1, branch: "feature", state: "clean" }] }] });
    const result = await stackStatus("stack-9", cfg);
    assert.equal((result.data.watch as { reason: string }).reason, "archived");
  });

  test("stack_status for a missing stack is done: not_found with neutral wording", async () => {
    mockFetch(200, { stacks: [] });
    const result = await stackStatus("stack-9", cfg);
    assert.equal(result.isError, true);
    assert.equal((result.data.watch as { reason: string }).reason, "not_found");
    assert.match(result.summary, /a mistyped id or another account's stack reads the same/);
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

  test("stack_status appends the shared CI blocker label and preserves summary fields", async () => {
    mockFetch(200, { stacks: [{
      id: "blocked-stack", owner: "acme", repo: "widgets",
      autoEnqueueWhenReady: true, autoReviewOverride: false,
      layers: [{ prNumber: 7, position: 1, state: "clean", ciStatus: "failure",
        checks: { failure: 1, failingName: "unit tests" } }],
    }] });
    const result = await stackStatus("blocked-stack", cfg);
    assert.equal(statusLine(result.summary),
      "acme/widgets · 1 layer · restack: clean · auto-land on · auto-review off · blocked: #7 CI failed — unit tests");
  });

  test("stack_status reports a live merge-queue wait in its summary and data", async () => {
    const stack = {
      id: "waiting-stack", owner: "acme", repo: "widgets",
      layers: [{ prNumber: 7, position: 1, state: "clean", ciStatus: "success" }],
    };
    const entry = {
      id: "queue-entry", stackId: stack.id, owner: stack.owner, repo: stack.repo,
      state: "waiting", position: 1, waitReason: "CI pending on abc1234", bounceReason: null,
      bounceDetail: null, enqueuedBy: "agent", enqueuedVia: "cli",
      enqueuedAt: new Date(Date.now() - 15 * 60_000).toISOString(), attempts: 1,
      landedPrNumbers: [], verifyHeadSha: null, verifyBaseSha: null, finishedAt: null,
      claimedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    };
    originalFetch ??= globalThis.fetch;
    globalThis.fetch = async (input) => Response.json(
      String(input).includes("/stacks/queue") ? { entries: [entry] } : { stacks: [stack] },
    );
    const result = await stackStatus(stack.id, cfg);
    assert.match(statusLine(result.summary), /queue: #7 Merge queue waiting for 12m: CI pending on abc1234$/);
    assert.deepEqual(result.data.queueWait, {
      prNumber: 7, headSha: null,
      text: "Merge queue waiting for 12m: CI pending on abc1234",
      since: entry.claimedAt, waitReason: "CI pending on abc1234",
    });
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
      if (scenario === "current") assert.match(statusLine(result.summary), /blocked: #7 CI failed — unit tests$/);
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
        landingBlockReason: "ci_failure on land PR #99",
        members: [], landPr: { prNumber: 99, state: "clean" },
      },
    }] });
    const result = await stackStatus("unit-gated-stack", cfg);
    assert.match(result.summary, /blocked: #99 ci_failure on land PR #99$/);
  });

  test("old server: stack_status names a Tempest land gate by the server's text and ignores tempestLandStatus and Tempest runs", async () => {
    const unit = { state: "growing", landPrNumber: 99, tempestLandStatus: "failed", members: [],
      landPr: { prNumber: 99, state: "clean", headSha: "aaaaaaa", tempestStatus: "findings",
        agentRuns: [{ agent: "tempest", status: "findings", sha: "aaaaaaa" }] } };
    mockFetch(200, { stacks: [{ id: "old-server-stack", owner: "acme", repo: "widgets", layers: [],
      unit: { ...unit, landingBlockReason: "landing blocked: tempest_findings on land PR #99" } }] });
    const blocked = await stackStatus("old-server-stack", cfg);
    assert.match(blocked.summary, /blocked: #99 landing blocked: tempest_findings on land PR #99$/);
    mockFetch(200, { stacks: [{ id: "old-server-stack", owner: "acme", repo: "widgets", layers: [],
      unit: { ...unit, landingBlockReason: null } }] });
    const quiet = await stackStatus("old-server-stack", cfg);
    assert.doesNotMatch(quiet.summary, /blocked:|Tempest/i);
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
  ] as const) {
    test(`stack_status names a hard blocker: ${label}`, async () => {
      mockFetch(200, { stacks: [{
        id: "blocked-stack", owner: "acme", repo: "widgets",
        layers: [{ prNumber: 7, position: 1, state: "clean", headSha: "aaaaaaa", ...detail }],
      }] });
      const result = await stackStatus("blocked-stack", cfg);
      assert.ok(statusLine(result.summary).endsWith(`blocked: #7 ${label}`));
    });
  }
});
