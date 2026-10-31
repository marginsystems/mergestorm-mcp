import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError, IssueReviewTimeoutError, type IssueReviewStatus } from "mergestorm/client";
import { issueReviewWait } from "./issue-review-wait.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test" };
const TARGET = { owner: "acme", repo: "widgets", number: 12 };

function status(overrides: Partial<IssueReviewStatus> = {}): IssueReviewStatus {
  return {
    owner: "acme",
    repo: "widgets",
    number: 12,
    enabled: true,
    state: "needs_answers",
    approvedBy: null,
    round: 2,
    maxRounds: 4,
    verdict: "needs_answers",
    summary: "One question first.",
    points: [{ kind: "question", text: "Which repo?" }],
    commentUrl: "https://github.com/acme/widgets/issues/12#issuecomment-1",
    next: "Answer the point in a comment on #12.",
    ...overrides,
  };
}

test("issue_review_wait polls for one 45s slice by default and returns the endpoint JSON with a summary", async () => {
  const polls: unknown[] = [];
  const result = await issueReviewWait(TARGET, CFG, {
    getIssueReview: async () => assert.fail("a wait must poll"),
    pollIssueReview: async (cfg, target, opts) => {
      polls.push({ cfg, target, timeoutMs: opts?.timeoutMs });
      return status();
    },
  });
  assert.deepEqual(polls, [{ cfg: CFG, target: TARGET, timeoutMs: 45_000 }]);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.data, status());
  assert.equal(
    result.summary,
    "acme/widgets#12: needs_answers (round 2 of 4), 1 point to answer. Do not open the pull request yet. Answer the point in a comment on #12.",
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
  assert.equal(pending.summary, "acme/widgets#12: Vortex is still reviewing (round 2 of 4); call issue_review_wait again.");

  const off = await issueReviewWait(TARGET, CFG, {
    pollIssueReview: async () => status({ enabled: false, state: "off", verdict: null, points: [], round: null, next: "" }),
  });
  assert.equal(off.summary, "Issue reviews are off for acme/widgets; acme/widgets#12 needs no approval.");
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
