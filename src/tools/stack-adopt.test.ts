import { STACK_WATCH_NOT_DONE_SENTENCE,stackWatchObligation } from "mergestorm/client";
import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import type { StackAdoptInput } from "./stack-adopt.js";
import { stackAdopt } from "./stack-adopt.js";

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

  const adoptPolicies: Array<
    Partial<
      Pick<
        StackAdoptInput,
        "auto_land" | "auto_review" | "auto_patch" | "auto_resolve_conflicts" | "auto_fix_ci"
      >
    >
  > = [
    {},
    { auto_land: false, auto_review: null, auto_patch: false },
    { auto_land: true },
    { auto_land: false, auto_review: true, auto_patch: null },
    { auto_patch: true },
    { auto_review: false, auto_patch: null },
    { auto_resolve_conflicts: true, auto_fix_ci: null },
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
          ...("auto_resolve_conflicts" in policy
            ? { autoResolveConflictsOverride: policy.auto_resolve_conflicts }
            : {}),
          ...("auto_fix_ci" in policy ? { autoFixCiOverride: policy.auto_fix_ci } : {}),
        });
        return Response.json(body);
      };
      const result = await stackAdopt({ owner: " acme ", repo: "widgets", pr_number: 42, ...policy }, cfg);
      assert.equal(calls, 1);
      assert.equal(result.isError, undefined);
      assert.equal(stackBody(result.summary), "Adopted stack for acme/widgets#42");
      assert.deepEqual(result.data.result, body);
      assert.deepEqual(result.data.watch, stackWatchObligation({ stackId: "stack-9", terminal: null, unread: true, freshCursor: true }));
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
        { auto_land: null }, { auto_patch: "off" }, { auto_fix_ci: "on" }].map((override) => ({
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
    assert.deepEqual(result.data.error, {
      code: "busy",
      message: result.summary,
      exit_code: 1,
    });
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

  test("stack_adopt surfaces the server's Surge message and reason under the published code", async () => {
    const message =
      "Install the Mergestorm Surge GitHub App to adopt this pull request. Surge is the write app: adopt, restack, the merge queue, and Auto land all run through it. Install it from Agents.";
    mockFetch(400, { error: "cyclone_not_connected", reason: "surge_not_connected", message });
    const result = await stackAdopt({ owner: "acme", repo: "widgets", pr_number: 42 }, cfg);
    assert.equal(result.isError, true);
    assert.equal(result.summary, message);
    assert.deepEqual(result.data.error, {
      code: "cyclone_not_connected",
      message,
      exit_code: 1,
      reason: "surge_not_connected",
    });
  });

  test("stack_adopt adds no reason to a Cyclone refusal", async () => {
    const message = "Connect the Cyclone GitHub App to adopt this pull request.";
    mockFetch(400, { error: "cyclone_not_connected", message });
    const result = await stackAdopt({ owner: "acme", repo: "widgets", pr_number: 42 }, cfg);
    assert.deepEqual(result.data.error, { code: "cyclone_not_connected", message, exit_code: 1 });
  });

  test("stack_adopt turns a 409 issue_not_approved into the blocking issue, its points and what to do", async () => {
    mockFetch(409, {
      error: "issue_not_approved",
      message: "Vortex has not approved #12.",
      issues: [{
        owner: "acme", repo: "widgets", number: 12, enabled: true, state: "needs_answers", approvedBy: null,
        round: 1, maxRounds: 4, verdict: "needs_answers", summary: null,
        points: [{ kind: "question", text: "Which repo?" }], commentUrl: null, next: "Answer it on #12.",
      }],
    });
    const result = await stackAdopt({ owner: "acme", repo: "widgets", pr_number: 42 }, cfg);
    assert.equal(result.isError, true);
    assert.equal((result.data.error as { code: string }).code, "issue_not_approved");
    assert.equal(
      result.summary,
      [
        "Vortex has not approved #12.",
        "acme/widgets#12: needs_answers (round 1 of 4)",
        "  1. [question] Which repo?",
        "  Next: Answer it on #12.",
        "  Reply in a comment on #12, then run `mergestorm issue wait 12`.",
        "Do not open the pull request yet: answer the points in a comment on each issue, call issue_review_wait until it returns approved, then try again.",
      ].join("\n"),
    );
  });

  test("stack_adopt returns rate-limit details from the API", async () => {
    mockFetch(429, { error: "rate_limited", retry_after_seconds: 9 }, { "Retry-After": "9" });
    const result = await stackAdopt({ owner: "acme", repo: "widgets", pr_number: 42 }, cfg);
    const error = result.data.error as { code: string; retry_after_seconds?: number };
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retry_after_seconds, 9);
  });
});
