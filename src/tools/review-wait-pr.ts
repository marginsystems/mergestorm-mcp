import {
  PrReviewPollTimeoutError,
  loadConfig,
  pollPrVortexReview,
  type Config,
} from "mergestorm/client";
import {
  payloadFromPrRateLimit,
  payloadFromPrReview,
  prReviewSummary,
  prReviewTarget,
} from "./review-get-pr.js";
import { MCP_PR_WAIT_DEFAULT_S, waitTimeoutMs } from "./review-submit.js";
import type { ToolPayload } from "./types.js";

export type ReviewWaitPrOptions = {
  pollIntervalMs?: number;
  /** Exact pass on the head (#2027). */
  pass?: number;
  /** Only a pass later than this one on the head; fixed for the whole wait (#2027). */
  afterPass?: number;
};

export async function reviewWaitPr(
  owner: string,
  repo: string,
  prNumber: number,
  afterSha?: string,
  timeout_s?: number,
  cfg?: Config,
  opts: ReviewWaitPrOptions = {},
): Promise<ToolPayload> {
  const target = prReviewTarget(owner, repo, prNumber);
  const resolved = cfg ?? (await loadConfig());
  try {
    const envelope = await pollPrVortexReview(
      resolved,
      target.owner,
      target.repo,
      target.prNumber,
      {
        timeoutMs: waitTimeoutMs(timeout_s, MCP_PR_WAIT_DEFAULT_S),
        afterSha,
        pass: opts.pass,
        afterPass: opts.afterPass,
        intervalMs: opts.pollIntervalMs,
      },
    );
    return payloadFromPrReview(
      target.owner,
      target.repo,
      target.prNumber,
      envelope,
    );
  } catch (err) {
    if (err instanceof PrReviewPollTimeoutError) {
      const status = "in_progress";
      const expectedSha = afterSha?.trim().toLowerCase() ?? "";
      const observedSha = err.lastEnvelope?.head_sha?.trim().toLowerCase() ?? "";
      const headShaMatches =
        Boolean(
          observedSha &&
            expectedSha.length >= 7 &&
            (observedSha.startsWith(expectedSha) || expectedSha.startsWith(observedSha)),
        );
      const findingCount = headShaMatches
        ? err.lastEnvelope?.finding_count ?? null
        : null;
      return {
        summary: prReviewSummary(target.owner, target.repo, target.prNumber, {
          status,
          head_sha: err.lastEnvelope?.head_sha ?? null,
          finding_count: findingCount,
          phase: err.lastEnvelope?.phase ?? null,
        }),
        data: {
          status,
          head_sha: err.lastEnvelope?.head_sha ?? null,
          pass: headShaMatches ? err.lastEnvelope?.pass ?? null : null,
          finding_count: findingCount,
          phase: err.lastEnvelope?.phase ?? null,
          error: err.message,
        },
      };
    }
    const rateLimited = payloadFromPrRateLimit(
      err,
      target.owner,
      target.repo,
      target.prNumber,
    );
    if (rateLimited) return rateLimited;
    throw err;
  }
}
