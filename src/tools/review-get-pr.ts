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

export function payloadFromPrReview(
  owner: string,
  repo: string,
  prNumber: number,
  envelope: PrVortexReview,
): ToolPayload {
  return {
    summary: `${owner}/${repo}#${prNumber} · ${envelope.status}`,
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

export async function reviewGetPr(
  owner: string,
  repo: string,
  prNumber: number,
  cfg?: Config,
): Promise<ToolPayload> {
  const target = prReviewTarget(owner, repo, prNumber);
  try {
    const envelope = await getPrVortexReview(
      target.owner,
      target.repo,
      target.prNumber,
      cfg,
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
