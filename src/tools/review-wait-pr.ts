import {
  PrReviewPollTimeoutError,
  loadConfig,
  noPrReviewYetMessage,
  pollPrVortexReview,
  type Config,
} from "mergestorm/client";
import {
  payloadFromPrRateLimit,
  payloadFromPrReview,
  prReviewSummary,
  prReviewTarget,
  reviewGetPr,
} from "./review-get-pr.js";
import { MCP_PR_WAIT_DEFAULT_S, waitTimeoutMs } from "./review-submit.js";
import type { ToolPayload } from "./types.js";
import { CHAT_WAKE_REVIEW_NOTE, registerChatWake } from "./chat-wake.js";

export type ReviewWaitPrOptions = {
  pollIntervalMs?: number;
  /** Exact pass on the head (#2027). */
  pass?: number;
  /** Only a pass later than this one on the head; fixed for the whole wait (#2027). */
  afterPass?: number;
  chatId?: string;
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
  if (timeout_s === 0) {
    return reviewGetPr(target.owner, target.repo, target.prNumber, resolved, {
      afterSha,
      pass: opts.pass,
      afterPass: opts.afterPass,
    });
  }
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
      const status = err.reviewSeen ? "in_progress" : "none";
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
      const summary = prReviewSummary(target.owner, target.repo, target.prNumber, {
        status,
        head_sha: err.lastEnvelope?.head_sha ?? null,
        finding_count: findingCount,
        phase: err.lastEnvelope?.phase ?? null,
      });
      const wakeHead = expectedSha || observedSha || null;
      const wake = opts.chatId
        ? await registerChatWake(resolved, opts.chatId, {
            kind: "vortex",
            owner: target.owner,
            repo: target.repo,
            prNumber: target.prNumber,
            headSha: wakeHead,
            minPass: opts.pass ?? (opts.afterPass !== undefined ? opts.afterPass + 1 : (headShaMatches || !expectedSha) && observedSha ? err.lastEnvelope?.pass ?? null : null),
          })
        : null;
      const shown = err.reviewSeen
        ? summary
        : `${summary} · ${noPrReviewYetMessage(target.owner, target.repo, target.prNumber, { afterSha, pass: opts.pass, afterPass: opts.afterPass })}`;
      return {
        summary: wake ? `${shown} · ${CHAT_WAKE_REVIEW_NOTE}` : shown,
        data: {
          status,
          head_sha: err.lastEnvelope?.head_sha ?? null,
          pass: headShaMatches ? err.lastEnvelope?.pass ?? null : null,
          finding_count: findingCount,
          phase: err.lastEnvelope?.phase ?? null,
          error: err.message,
          ...(wake ? { chat_wake: wake } : {}),
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
