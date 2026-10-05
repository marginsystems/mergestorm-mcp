import assert from "node:assert/strict";
import { test } from "node:test";
import { pollStackWatch, sameHead, stackBlockers, type StackDto } from "mergestorm/client";
import { stackSummary } from "./stack-summary.js";

type Layer = StackDto["layers"][number];
const head = "a".repeat(40);
const base = { prNumber: 41, position: 0, branch: "feat/cowork-authors", parentBranch: "main",
  state: "clean", headSha: head, mergeableHeadSha: head, ciStatus: "success" } as Layer;
const fixture = (layers: Layer[]): StackDto => ({ id: "stack", owner: "owner", repo: "repo", layers } as StackDto);

for (const [detail, label] of [
  [{ state: "conflict" }, "Conflict"],
  [{ draft: true }, "Draft PR"],
  [{ mergeable: false }, "Merge conflicts vs main"],
  [{ ciStatus: "failure", checks: { failingName: "unit" } }, "CI failed — unit"],
  [{ vortexStatus: "failed" }, "Review failed"],
  [{ vortexStatus: "skipped", vortexReview: { status: "skipped", skip_reason: "quota_exceeded", pass: 1, head_sha: head,
    phase: null, started_at: null, stoppable: false, source: "pr_reviews" } }, "Review skipped, out of review quota"],
] as [Partial<Layer>, string][]) {
  test(`one label table drives CLI attention and MCP blocked: ${label}`, async () => {
    const stack = fixture([{ ...base, ...detail }]);
    const result = await pollStackWatch({}, stack.id, { timeoutMs: 0,
      fetch: async (_cfg, route) => ({ status: 200, body: route.includes("/stacks/queue") ? { entries: [] } : { stacks: [stack] } }),
    });
    assert.equal(result.blocker, label);
    assert.ok(stackSummary(stack).endsWith(`blocked: #${result.prNumber} ${result.blocker}`));
    if (detail.draft) assert.equal(result.bounceKind, "pr_draft");
  });
}

test("old server: a Tempest agent run on a layer is not a blocker in the CLI watch or the MCP summary", async () => {
  const stack = fixture([{ ...base, agentRuns: [{ agent: "tempest", status: "findings", sha: head }] } as unknown as Layer]);
  const result = await pollStackWatch({}, stack.id, { timeoutMs: 0,
    fetch: async (_cfg, route) => ({ status: 200, body: route.includes("/stacks/queue") ? { entries: [] } : { stacks: [stack] } }),
  });
  assert.equal(result.blocker, null);
  assert.deepEqual(result.busy, []);
  assert.doesNotMatch(stackSummary(stack), /blocked:|Tempest/);
});

test("MCP Organism summary has pair gate and parked CI issue, not parked DIRTY", () => {
  const stack = fixture([base,
    { ...base, prNumber: 42, position: 1, parentBranch: base.branch, mergeable: false },
    ...[43, 44, 45].map(prNumber => ({ ...base, prNumber, position: prNumber - 41,
      parentBranch: "mg-park-freeze", lastRestackedSha: head, mergeable: false,
      ciStatus: prNumber === 45 ? "failure" : "success" } as Layer)),
  ]);
  assert.equal(stackSummary(stack), "owner/repo · 5 layers · restack: clean · auto-land off · blocked: #42 Merge conflicts vs feat/cowork-authors · issues: #45 CI failed");
});

test("all live hard block kinds become upstack issues; summary caps at three", () => {
  const stack = fixture([base, ...[
    { state: "conflict" }, { mergeable: false }, { draft: true }, { ciStatus: "failure" },
    { vortexStatus: "failed" },
  ].map((detail, i) => ({ ...base, ...detail, prNumber: 42 + i, position: i + 1 } as Layer))]);
  assert.equal(stackBlockers(stack).issues.length, 5);
  assert.match(stackSummary(stack), /issues: #42 Conflict; #43 Merge conflicts vs main; #44 Draft PR; \+2 more$/);
});

test("layers below the current candidate are not reported as upstack issues", () => {
  const stack = {
    ...fixture([
      { ...base, ciStatus: "failure", checks: { total: 1, success: 0, pending: 0, failure: 1, failingName: "unit" } },
      { ...base, prNumber: 42, position: 1, branch: "candidate" },
    ]),
    unit: { members: [{ prNumber: 41, promotedHeadSha: head }] },
  } as StackDto;
  assert.equal(stackBlockers(stack).currentCandidate?.prNumber, 42);
  assert.deepEqual(stackBlockers(stack).issues, []);
});

test("sameHead handles case, abbreviations, and full SHAs consistently", () => {
  assert.ok(sameHead(head, "AAAAAAA"));
  assert.ok(sameHead("AAAAAAA", head));
  assert.equal(sameHead(head, "b".repeat(40)), false);
  assert.equal(sameHead(`${"a".repeat(7)}${"b".repeat(33)}`, `${"a".repeat(7)}${"c".repeat(33)}`), false);
  assert.equal(sameHead(null, head), false);
});

test("unverified parked DIRTY is not merge conflicts", () => {
  const stack = fixture([{ ...base, parentBranch: "mg-park-freeze", lastRestackedSha: "old",
    mergeable: false }]);
  assert.equal(stackBlockers(stack).attention, null);
});

test("unverified DIRTY mergeability is not merge conflicts", async () => {
  const stack = fixture([{ ...base, mergeable: null, mergeableState: "dirty" }]);
  const result = await pollStackWatch({}, stack.id, {
    timeoutMs: 0,
    fetch: async (_cfg, route) => ({
      status: 200,
      body: route.includes("/stacks/queue") ? { entries: [] } : { stacks: [stack] },
    }),
  });
  assert.equal(result.blocker, null);
});

test("parked engine conflict still attention", () => {
  const stack = fixture([{ ...base, parentBranch: "mg-park-freeze", lastRestackedSha: "old",
    mergeable: false, state: "conflict" }]);
  assert.equal(stackBlockers(stack).attention?.blocker, "Conflict");
});

test("parked restackError still attention", () => {
  const stack = fixture([{ ...base, parentBranch: "mg-park-freeze", lastRestackedSha: "old",
    mergeable: false, restackError: { kind: "push_failed", attempts: 3, detail: "force-push failed" } } as Layer]);
  assert.equal(stackBlockers(stack).attention?.blocker, "Restack failed");
});

test("stack_status blockers and summary hold a PR Cyclone is patching, like stack_wait", async () => {
  const stack = fixture([{ ...base, ciStatus: "failure", checks: { failingName: "unit" }, cycloneStatus: "patching" } as Layer]);
  const blockers = stackBlockers(stack);
  assert.equal(blockers.attention, null);
  assert.deepEqual(blockers.busy, [{ prNumber: 41, headSha: head, agent: "cyclone", blocker: "CI failed — unit" }]);
  assert.ok(stackSummary(stack).endsWith("held: #41 CI failed — unit while Cyclone patches"));
  const result = await pollStackWatch({}, stack.id, { timeoutMs: 0,
    fetch: async (_cfg, route) => ({ status: 200, body: route.includes("/stacks/queue") ? { entries: [] } : { stacks: [stack] } }),
  });
  assert.equal(result.status, "in_progress");
  assert.deepEqual(result.busy, blockers.busy);
});

const seamStack = (seamState: string, seamReviewedSha: string | null, extra: Partial<Layer> = {}) => ({
  ...fixture([{ ...base, prNumber: 2818, ...extra }]),
  unit: { landPrNumber: 50, members: [
    { prNumber: 2817, promotedHeadSha: "b".repeat(40), seamState: "none", seamReviewedSha: null },
    { prNumber: 2818, promotedHeadSha: null, promotedAt: "2026-09-27T00:28:21Z", seamState, seamReviewedSha },
  ] },
} as StackDto);

test("stack_status and stack_wait block a unit member whose seam has findings at its head", async () => {
  const stack = seamStack("findings", head);
  assert.deepEqual(stackBlockers(stack).attention, { prNumber: 2818, headSha: head, blocker: "Seam findings", bounceKind: null });
  assert.ok(stackSummary(stack).endsWith("blocked: #2818 Seam findings"));
  const result = await pollStackWatch({}, stack.id, { timeoutMs: 0,
    fetch: async (_cfg, route) => ({ status: 200, body: route.includes("/stacks/queue") ? { entries: [] } : { stacks: [stack] } }),
  });
  assert.equal(result.status, "attention");
  assert.equal(result.blocker, "Seam findings");
  assert.equal(stackBlockers(seamStack("failed", null)).attention?.blocker, "Seam review failed");
});

test("approved-at-head, none, and running pending seams are not stack_status blockers", () => {
  for (const [seamState, reviewed] of [["approved", head], ["none", null]] as const) {
    assert.equal(stackBlockers(seamStack(seamState, reviewed)).attention, null, seamState);
  }
  const running = seamStack("pending", head, { agentRuns: [{ agent: "vortex", status: "reviewing", sha: head }] } as Partial<Layer>);
  assert.equal(stackBlockers(running).attention, null);
  assert.deepEqual(stackBlockers(running).busy, []);
});

test("a stuck, re-review-pending, or stale seam with no review running is a stack_status blocker", () => {
  const stale = seamStack("findings", "c".repeat(40));
  assert.equal(stackBlockers(stale).attention?.blocker, "Seam verdict is for an older head, no review running");
  assert.equal(stackBlockers(stale).repair?.kind, "seam_review_stuck");
  assert.ok(stackSummary(stale).endsWith("blocked: #2818 Seam verdict is for an older head, no review running"));
  assert.equal(stackBlockers(seamStack("reviewing", "c".repeat(40))).attention?.blocker,
    "Seam review stuck in reviewing, no review running");
  assert.equal(stackBlockers(seamStack("pending_rereview", "c".repeat(40))).attention?.blocker,
    "Seam re-review pending, no review running");
  const running = seamStack("reviewing", "c".repeat(40), { agentRuns: [{ agent: "vortex", status: "reviewing", sha: head }] } as Partial<Layer>);
  assert.equal(stackBlockers(running).attention, null);
});

test("a pending seam with no review running is a stack_status blocker", () => {
  assert.equal(stackBlockers(seamStack("pending", head)).attention?.blocker, "Seam review pending, no review running");
});

test("stack_status holds seam findings while Vortex re-reviews the seam", () => {
  const stack = seamStack("findings", head, { agentRuns: [{ agent: "vortex", status: "reviewing", sha: head }] } as Partial<Layer>);
  const blockers = stackBlockers(stack);
  assert.equal(blockers.attention, null);
  assert.deepEqual(blockers.busy, [{ prNumber: 2818, headSha: head, agent: "vortex", blocker: "Seam findings" }]);
  assert.ok(stackSummary(stack).endsWith("held: #2818 Seam findings while Vortex reviews"));
});
