import {
  PrReviewPollTimeoutError,
  loadConfig,
  pollPrVortexReview,
  type Config,
} from "mergestorm/client";
import {
  payloadFromPrRateLimit,
  payloadFromPrReview,
  prReviewTarget,
} from "./review-get-pr.js";
import { waitTimeoutMs } from "./review-submit.js";
import type { ToolPayload } from "./types.js";

export type ReviewWaitPrOptions = {
  pollIntervalMs?: number;
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
        timeoutMs: waitTimeoutMs(timeout_s),
        afterSha,
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
      const status = err.lastEnvelope?.status ?? "in_progress";
      return {
        summary: `${target.owner}/${target.repo}#${target.prNumber} · ${status}`,
        data: {
          ...(err.lastEnvelope ?? {}),
          status,
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
