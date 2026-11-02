import {
  CommandError,
  IssueReviewTimeoutError,
  NO_LINKED_ISSUE,
  getIssueReview,
  issueReviewStallAdvice,
  issueReviewWaitAfter,
  loadConfig,
  pollIssueReview,
  type Config,
  type IssueReviewStatus,
} from "mergestorm/client";
import { z } from "zod";
import type { ToolPayload } from "./types.js";

export const ISSUE_REVIEW_WAIT_MAX_S = 45;

export const issueReviewWaitSchema = {
  owner: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  repo: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  number: z.number().int().min(1),
  timeout_s: z.number().min(0).max(ISSUE_REVIEW_WAIT_MAX_S).optional(),
  after_round: z.number().int().min(1).optional(),
  waiting_since: z.string().datetime({ offset: true }).optional(),
};
const inputSchema = z.object(issueReviewWaitSchema);
export type IssueReviewWaitInput = z.infer<typeof inputSchema>;

export type IssueReviewWaitDeps = {
  getIssueReview?: typeof getIssueReview;
  pollIssueReview?: typeof pollIssueReview;
  pollIntervalMs?: number;
  now?: () => number;
};

export type IssueReviewWaitNextArgs = { owner: string; repo: string; number: number; after_round?: number; waiting_since?: string };

function blockingCount(status: IssueReviewStatus): number {
  return status.points.filter((point) => point.blocking !== false).length;
}

export function issueReviewSummary(status: IssueReviewStatus): string {
  const ref = `${status.owner}/${status.repo}#${status.number}`;
  const round = status.round ? ` (round ${status.round} of ${status.maxRounds})` : "";
  const wait = status.wait;
  if (wait.status === "stalled") {
    const since = wait.minutes !== null ? ` for ${wait.minutes} min` : "";
    return `${ref}: stalled, no new Vortex round${since} (reason: ${wait.reason}). ${issueReviewStallAdvice(wait.reason, status.mode)} Tell the human once and stop; do not call issue_review_wait in a loop.`;
  }
  if (wait.status === "answered_waiting_for_round" && wait.reason === "answer_not_seen") {
    return `${ref}: Vortex has not seen an answer after round ${wait.verdictRound ?? status.round} yet. If you have not posted your answer, post it now in one issue comment; then call issue_review_wait again with next_args. Do not poll GitHub.`;
  }
  if (wait.status === "answered_waiting_for_round") {
    return `${ref}: Vortex has an answer after round ${wait.verdictRound ?? status.round}; the next round has not finished. Call issue_review_wait again with next_args; do not poll GitHub.`;
  }
  if (wait.status === "round_running" && status.state !== "pending") {
    return `${ref}: Vortex is running a round${round}; call issue_review_wait again with next_args.`;
  }
  const head =
    status.state === "approved"
      ? status.approvedBy === null
        ? `The Vortex review of ${ref} failed, so it does not hold the pull request back; you may open it.`
        : `${ref} is approved by ${status.approvedBy === "human" ? "a person" : "Vortex"}; you may open the pull request.`
      : status.state === "off"
        ? `Issue reviews are off for ${status.owner}/${status.repo}; ${ref} needs no approval.`
        : status.mode === "mention" && status.state === "unreviewed"
          ? `Issue reviews for ${status.owner}/${status.repo} run on mention; ${ref} needs no approval, so you may open the pull request.`
          : status.state === "pending"
          ? `${ref}: Vortex is still reviewing${round}; call issue_review_wait again with next_args.`
          : `${ref}: ${status.state}${round}, ${blockingCount(status)} point${blockingCount(status) === 1 ? "" : "s"} to answer.${status.mode === "auto" ? " Do not open the pull request yet." : ""} After you answer in one issue comment, call issue_review_wait once with next_args.`;
  return status.next ? `${head} ${status.next}` : head;
}

export const ISSUE_NOT_APPROVED_HINT =
  "Do not open the pull request yet: reply once in a comment on each issue, accepting each blocking point's suggested fix or saying why not (notes do not block), call issue_review_wait with its next_args until it returns approved or stalled, then try again. Never poll GitHub.";

export function withIssueReviewHint(err: unknown, message: string): string {
  return err instanceof CommandError && err.code === "issue_not_approved" && err.reason !== NO_LINKED_ISSUE ? `${message}\n${ISSUE_NOT_APPROVED_HINT}` : message;
}

function nextArgs(status: IssueReviewStatus, input: IssueReviewWaitInput, waitingSince: string): IssueReviewWaitNextArgs | null {
  const target = { owner: input.owner, repo: input.repo, number: input.number };
  const wait = status.wait;
  if (wait.status === "approved" || wait.status === "stalled") return null;
  if (wait.status === "points") return wait.verdictRound ? { ...target, after_round: wait.verdictRound } : target;
  const after = input.after_round ?? wait.verdictRound ?? undefined;
  return { ...target, ...(after ? { after_round: after } : {}), waiting_since: waitingSince };
}

function failure(code: string, message: string, extra: Record<string, unknown> = {}): ToolPayload {
  return { summary: message, data: { error: { code, message, ...extra } }, isError: true };
}

export async function issueReviewWait(
  input: IssueReviewWaitInput,
  cfg?: Config,
  deps: IssueReviewWaitDeps = {},
): Promise<ToolPayload> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return failure("invalid_input", `issue_review_wait needs owner, repo, a positive issue number and timeout_s from 0 to ${ISSUE_REVIEW_WAIT_MAX_S}`);
  }
  const { owner, repo, number, timeout_s, after_round, waiting_since } = parsed.data;
  const target = { owner, repo, number };
  const now = deps.now ?? Date.now;
  const since = Math.min(waiting_since ? Date.parse(waiting_since) : now(), now());
  const sinceIso = new Date(since).toISOString();
  const withNext = (status: IssueReviewStatus): ToolPayload => {
    const next = nextArgs(status, parsed.data, sinceIso);
    return { summary: issueReviewSummary(status), data: { ...status, ...(next ? { next_args: next } : {}) } };
  };
  try {
    const resolved = cfg ?? (await loadConfig());
    const read = timeout_s === 0 ? await (deps.getIssueReview ?? getIssueReview)(resolved, target) : null;
    const status = timeout_s === 0
      ? read && { ...read, wait: issueReviewWaitAfter(read, { afterRound: after_round, waitedMs: now() - since, nowMs: now() }) }
      : await (deps.pollIssueReview ?? pollIssueReview)(resolved, target, {
        timeoutMs: Math.max(1, Math.round((timeout_s ?? ISSUE_REVIEW_WAIT_MAX_S) * 1000)),
        ...(after_round !== undefined ? { afterRound: after_round } : {}),
        waitingSince: since,
        ...(deps.pollIntervalMs !== undefined ? { intervalMs: deps.pollIntervalMs } : {}),
      });
    if (!status) {
      return failure(
        "issue_review_unavailable",
        "This Mergestorm server does not review issues yet. Open the pull request as before.",
      );
    }
    return withNext(status);
  } catch (err) {
    if (err instanceof IssueReviewTimeoutError) return withNext(err.lastStatus);
    const message = err instanceof Error ? err.message : String(err);
    return failure(
      err instanceof CommandError ? err.code ?? "issue_review_wait_failed" : "issue_review_wait_failed",
      message,
      err instanceof CommandError && err.retryAfterSeconds !== undefined ? { retry_after_seconds: err.retryAfterSeconds } : {},
    );
  }
}
