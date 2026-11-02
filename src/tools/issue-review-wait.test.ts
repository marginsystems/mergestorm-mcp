import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError, IssueReviewTimeoutError, NO_LINKED_ISSUE, type IssueReviewStatus } from "mergestorm/client";
import { ISSUE_NOT_APPROVED_HINT, issueReviewWait, withIssueReviewHint } from "./issue-review-wait.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test" };
const TARGET = { owner: "acme", repo: "widgets", number: 12 };

function status(overrides: Partial<IssueReviewStatus> = {}): IssueReviewStatus {
  return {
    owner: "acme",
    repo: "widgets",
    number: 12,
    enabled: true,
    mode: "auto",
    state: "needs_answers",
    approvedBy: null,
    round: 2,
    maxRounds: 4,
    verdict: "needs_answers",
    summary: "One question first.",
    points: [{ kind: "question", text: "Which repo?" }],
    commentUrl: "https://github.com/acme/widgets/issues/12#issuecomment-1",
    next: "Answer the point in a comment on #12.",
    wait: waitFor(overrides.state ?? "needs_answers", overrides.round === undefined ? 2 : overrides.round),
    ...overrides,
  };
}

function waitFor(state: IssueReviewStatus["state"], round: number | null): IssueReviewStatus["wait"] {
  const status = state === "needs_answers" ? "points" : state === "pending" || state === "unreviewed" ? "round_running" : "approved";
  return { status, reason: state, verdictRound: round, verdictAt: null, answeredAt: null, retryAt: null, minutes: null };
}

const NOW = Date.parse("2026-11-02T07:00:00Z");

test("issue_review_wait polls for one 45s slice by default and returns the endpoint JSON with a summary", async () => {
  const polls: unknown[] = [];
  const result = await issueReviewWait(TARGET, CFG, {
    now: () => NOW,
    getIssueReview: async () => assert.fail("a wait must poll"),
    pollIssueReview: async (cfg, target, opts) => {
      polls.push({ cfg, target, timeoutMs: opts?.timeoutMs, waitingSince: opts?.waitingSince });
      return status();
    },
  });
  assert.deepEqual(polls, [{ cfg: CFG, target: TARGET, timeoutMs: 45_000, waitingSince: NOW }]);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.data, { ...status(), next_args: { ...TARGET, after_round: 2 } });
  assert.equal(
    result.summary,
    "acme/widgets#12: needs_answers (round 2 of 4), 1 point to answer. Do not open the pull request yet. After you answer in one issue comment, call issue_review_wait once with next_args. Answer the point in a comment on #12.",
  );
});

test("issue_review_wait with timeout_s 0 reads the review once without polling", async () => {
  const result = await issueReviewWait({ ...TARGET, timeout_s: 0 }, CFG, {
    getIssueReview: async () => status({ state: "approved", approvedBy: "human", verdict: null, points: [], next: "" }),
    pollIssueReview: async () => assert.fail("timeout_s 0 must not poll"),
  });
  assert.equal(result.summary, "acme/widgets#12 is approved by a person; you may open the pull request.");
  assert.equal(result.data.state, "approved");
});

test("issue_review_wait returns pending at the end of the slice, and off as no approval needed", async () => {
  const pending = await issueReviewWait({ ...TARGET, timeout_s: 5 }, CFG, {
    pollIssueReview: async (_cfg, _target, opts) => {
      assert.equal(opts?.timeoutMs, 5_000);
      throw new IssueReviewTimeoutError(status({ state: "pending", verdict: null, points: [], next: "" }));
    },
  });
  assert.equal(pending.isError, undefined);
  assert.equal(pending.data.state, "pending");
  assert.equal(pending.summary, "acme/widgets#12: Vortex is still reviewing (round 2 of 4); call issue_review_wait again with next_args.");

  const off = await issueReviewWait(TARGET, CFG, {
    pollIssueReview: async () => status({ enabled: false, state: "off", verdict: null, points: [], round: null, next: "" }),
  });
  assert.equal(off.summary, "Issue reviews are off for acme/widgets; acme/widgets#12 needs no approval.");
});

test("issue_review_wait carries the round cursor and the stall clock from one slice to the next", async () => {
  const since = "2026-11-02T06:50:00.000Z";
  const seen: unknown[] = [];
  const result = await issueReviewWait({ ...TARGET, after_round: 2, waiting_since: since }, CFG, {
    now: () => NOW,
    pollIssueReview: async (_cfg, _target, opts) => {
      seen.push({ afterRound: opts?.afterRound, waitingSince: opts?.waitingSince });
      throw new IssueReviewTimeoutError(status({ state: "needs_answers", wait: { ...waitFor("needs_answers", 2), status: "answered_waiting_for_round", reason: "answer_not_seen" } }));
    },
  });
  assert.deepEqual(seen, [{ afterRound: 2, waitingSince: Date.parse(since) }]);
  assert.deepEqual(result.data.next_args, { ...TARGET, after_round: 2, waiting_since: since });
  assert.match(result.summary, /has not seen an answer after round 2 yet\. If you have not posted your answer, post it now/);
});

test("issue_review_wait with timeout_s 0 still holds back a verdict the cursor already saw", async () => {
  const result = await issueReviewWait({ ...TARGET, timeout_s: 0, after_round: 2 }, CFG, { now: () => NOW, getIssueReview: async () => status() });
  assert.equal((result.data.wait as { status: string }).status, "answered_waiting_for_round");
  assert.ok(result.data.next_args);
});

test("issue_review_wait reports a stall once with its reason and no next_args", async () => {
  const result = await issueReviewWait({ ...TARGET, after_round: 2 }, CFG, {
    now: () => NOW,
    pollIssueReview: async () => status({ state: "pending", wait: { ...waitFor("pending", 2), status: "stalled", reason: "unchanged", minutes: 15 } }),
  });
  assert.equal(result.data.next_args, undefined);
  assert.match(result.summary, /^acme\/widgets#12: stalled, no new Vortex round for 15 min \(reason: unchanged\)\. .* Tell the human once and stop/);
});

test("issue_review_wait says an untagged issue in mention mode needs no approval", async () => {
  const mention = await issueReviewWait(TARGET, CFG, {
    pollIssueReview: async () => status({ mode: "mention", state: "unreviewed", verdict: null, points: [], round: null, next: "", wait: waitFor("approved", null) }),
  });
  assert.equal(mention.summary, "Issue reviews for acme/widgets run on mention; acme/widgets#12 needs no approval, so you may open the pull request.");
});

test("issue_review_wait refuses bad input and reports an older server and API errors by code", async () => {
  for (const input of [{ ...TARGET, number: 0 }, { ...TARGET, timeout_s: 46 }, { ...TARGET, owner: "a b" }]) {
    const refused = await issueReviewWait(input, CFG, { pollIssueReview: async () => assert.fail("no read") });
    assert.equal((refused.data.error as { code: string }).code, "invalid_input", JSON.stringify(input));
  }
  const older = await issueReviewWait(TARGET, CFG, { pollIssueReview: async () => null });
  assert.equal(older.isError, true);
  assert.equal((older.data.error as { code: string }).code, "issue_review_unavailable");
  const limited = await issueReviewWait(TARGET, CFG, {
    pollIssueReview: async () => {
      throw new CommandError("Rate limited.", 7, "rate_limited", { retryAfterSeconds: 9 });
    },
  });
  assert.deepEqual(limited.data.error, { code: "rate_limited", message: "Rate limited.", retry_after_seconds: 9 });
});

test("withIssueReviewHint adds the reply hint to a refusal that names issues", () => {
  const err = new CommandError("#12 is needs answers.", 4, "issue_not_approved");
  assert.equal(withIssueReviewHint(err, err.message), `#12 is needs answers.\n${ISSUE_NOT_APPROVED_HINT}`);
});

test("withIssueReviewHint leaves a refusal for a missing Fixes #N link without the reply hint", () => {
  const err = new CommandError("add Fixes #N for the PR's issue to the PR body", 4, "issue_not_approved", { reason: NO_LINKED_ISSUE });
  assert.equal(withIssueReviewHint(err, err.message), err.message);
});
