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
  [{ agentRuns: [{ agent: "tempest", status: "findings", sha: head }] }, "Tempest findings"],
  [{ agentRuns: [{ agent: "tempest", status: "failed", sha: head }] }, "Tempest failed"],
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
    { agentRuns: [{ agent: "tempest", status: "failed", sha: head }] }, { vortexStatus: "failed" },
  ].map((detail, i) => ({ ...base, ...detail, prNumber: 42 + i, position: i + 1 } as Layer))]);
  assert.equal(stackBlockers(stack).issues.length, 6);
  assert.match(stackSummary(stack), /issues: #42 Conflict; #43 Merge conflicts vs main; #44 Draft PR; \+3 more$/);
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
