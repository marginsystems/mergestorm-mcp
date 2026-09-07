import {
  CommandError,
  getPrVortexReview,
  isCommandErrorCode,
  type Config,
  type PrVortexReview,
} from "mergestorm/client";
import type { ToolPayload } from "./types.js";

export function prReviewTarget(owner: string, repo: string, prNumber: number) {
  const cleanOwner = owner.trim();
  const cleanRepo = repo.trim();
  if (!cleanOwner || !cleanRepo || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new CommandError(
      "owner, repo, and a positive pr_number are required",
      2,
      "usage",
    );
  }
  return { owner: cleanOwner, repo: cleanRepo, prNumber };
}

export function prReviewSummary(
  owner: string,
  repo: string,
  prNumber: number,
  envelope: {
    status: string;
    head_sha?: string | null;
    finding_count?: number | null;
    phase?: string | null;
  },
): string {
  const bits = [`${owner}/${repo}#${prNumber}`, envelope.status];
  const sha = envelope.head_sha?.trim();
  if (sha) bits.push(`sha ${sha.slice(0, 7)}`);
  if (typeof envelope.finding_count === "number") {
    bits.push(
      `${envelope.finding_count} finding${envelope.finding_count === 1 ? "" : "s"}`,
    );
  }
  if (envelope.phase) bits.push(String(envelope.phase));
  return bits.join(" · ");
}

export function payloadFromPrReview(
  owner: string,
  repo: string,
  prNumber: number,
  envelope: PrVortexReview,
): ToolPayload {
  return {
    summary: prReviewSummary(owner, repo, prNumber, envelope),
    data: { ...envelope },
  };
}

export function payloadFromPrRateLimit(
  err: unknown,
  owner: string,
  repo: string,
  prNumber: number,
): ToolPayload | null {
  if (!isCommandErrorCode(err, "rate_limited")) return null;
  return {
    summary: `${owner}/${repo}#${prNumber} · rate_limited`,
    data: {
      status: "rate_limited",
      error: err.message,
      retry_after_seconds: err.retryAfterSeconds,
    },
  };
}

/** SHA + pass selection (#2027): `pass` is one exact attempt, `afterPass` a later one on the head. */
export type ReviewGetPrOptions = {
  afterSha?: string;
  pass?: number;
  afterPass?: number;
};

export async function reviewGetPr(
  owner: string,
  repo: string,
  prNumber: number,
  cfg?: Config,
  opts: ReviewGetPrOptions = {},
): Promise<ToolPayload> {
  const target = prReviewTarget(owner, repo, prNumber);
  try {
    const envelope = await getPrVortexReview(
      target.owner,
      target.repo,
      target.prNumber,
      cfg,
      { afterSha: opts.afterSha, pass: opts.pass, afterPass: opts.afterPass },
    );
    return payloadFromPrReview(
      target.owner,
      target.repo,
      target.prNumber,
      envelope,
    );
  } catch (err) {
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
