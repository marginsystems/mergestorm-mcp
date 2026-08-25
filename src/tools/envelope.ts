import {
  isCommandErrorCode,
  toReviewJobEnvelope,
  type ReviewEnvelopeFallbacks,
  type ReviewJobRow,
} from "mergestorm/client";
import type { ToolPayload } from "./types.js";

export const MCP_REVIEW_STATUSES = [
  "no_changes",
  "queued",
  "in_progress",
  "completed",
  "failed",
  "quota_exceeded",
  "rate_limited",
] as const;

export function payloadFromRow(
  row: ReviewJobRow | null,
  fallback: ReviewEnvelopeFallbacks = {},
): ToolPayload {
  const envelope = toReviewJobEnvelope(row, fallback);
  const bits = [envelope.status];
  if (envelope.verdict) bits.push(envelope.verdict);
  return {
    summary: `${envelope.job_id ?? fallback.jobId ?? "review"} · ${bits.join(" · ")}`,
    data: envelope,
  };
}

export function payloadFromRateLimit(
  err: unknown,
  jobId?: string | null,
): ToolPayload | null {
  if (!isCommandErrorCode(err, "rate_limited")) return null;
  return payloadFromRow(null, {
    jobId,
    status: "rate_limited",
    error: err.message,
    retryAfterSeconds: err.retryAfterSeconds,
  });
}
