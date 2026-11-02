import {
  CommandError,
  IssueReviewTimeoutError,
  NO_LINKED_ISSUE,
  getIssueReview,
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
};
const inputSchema = z.object(issueReviewWaitSchema);
export type IssueReviewWaitInput = z.infer<typeof inputSchema>;

export type IssueReviewWaitDeps = {
  getIssueReview?: typeof getIssueReview;
  pollIssueReview?: typeof pollIssueReview;
  pollIntervalMs?: number;
};

function blockingCount(status: IssueReviewStatus): number {
  return status.points.filter((point) => point.blocking !== false).length;
}

export function issueReviewSummary(status: IssueReviewStatus): string {
  const ref = `${status.owner}/${status.repo}#${status.number}`;
  const round = status.round ? ` (round ${status.round} of ${status.maxRounds})` : "";
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
          ? `${ref}: Vortex is still reviewing${round}; call issue_review_wait again.`
          : `${ref}: ${status.state}${round}, ${blockingCount(status)} point${blockingCount(status) === 1 ? "" : "s"} to answer.${status.mode === "auto" ? " Do not open the pull request yet." : ""}`;
  return status.next ? `${head} ${status.next}` : head;
}

export const ISSUE_NOT_APPROVED_HINT =
  "Do not open the pull request yet: reply once in a comment on each issue, accepting each blocking point's suggested fix or saying why not (notes do not block), call issue_review_wait until it returns approved, then try again.";

export function withIssueReviewHint(err: unknown, message: string): string {
  return err instanceof CommandError && err.code === "issue_not_approved" && err.reason !== NO_LINKED_ISSUE ? `${message}\n${ISSUE_NOT_APPROVED_HINT}` : message;
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
  const { owner, repo, number, timeout_s } = parsed.data;
  const target = { owner, repo, number };
  try {
    const resolved = cfg ?? (await loadConfig());
    const status = timeout_s === 0
      ? await (deps.getIssueReview ?? getIssueReview)(resolved, target)
      : await (deps.pollIssueReview ?? pollIssueReview)(resolved, target, {
        timeoutMs: Math.max(1, Math.round((timeout_s ?? ISSUE_REVIEW_WAIT_MAX_S) * 1000)),
        ...(deps.pollIntervalMs !== undefined ? { intervalMs: deps.pollIntervalMs } : {}),
      });
    if (!status) {
      return failure(
        "issue_review_unavailable",
        "This Mergestorm server does not review issues yet. Open the pull request as before.",
      );
    }
    return { summary: issueReviewSummary(status), data: { ...status } };
  } catch (err) {
    if (err instanceof IssueReviewTimeoutError) {
      return { summary: issueReviewSummary(err.lastStatus), data: { ...err.lastStatus } };
    }
    const message = err instanceof Error ? err.message : String(err);
    return failure(
      err instanceof CommandError ? err.code ?? "issue_review_wait_failed" : "issue_review_wait_failed",
      message,
      err instanceof CommandError && err.retryAfterSeconds !== undefined ? { retry_after_seconds: err.retryAfterSeconds } : {},
    );
  }
}
