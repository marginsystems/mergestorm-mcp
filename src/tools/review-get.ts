import {
  CommandError,
  getReview,
  toReviewJobEnvelope,
  type Config,
  type ReviewJobRow,
} from "mergestorm/client";
import { payloadFromRateLimit } from "./envelope.js";
import type { ToolPayload } from "./types.js";

export async function reviewGet(jobId: string, cfg?: Config): Promise<ToolPayload> {
  let row: unknown;
  try {
    row = await getReview(jobId, cfg);
  } catch (err) {
    const rateLimited = payloadFromRateLimit(err, jobId);
    if (rateLimited) return rateLimited;
    throw err;
  }
  if (
    !row ||
    typeof row !== "object" ||
    typeof (row as ReviewJobRow).status !== "string"
  ) {
    throw new CommandError(`Unexpected response for review ${jobId}.`);
  }
  const envelope = toReviewJobEnvelope(row as ReviewJobRow, { jobId });
  const bits = [envelope.status];
  if (envelope.verdict) bits.push(envelope.verdict);
  return {
    summary: `${envelope.job_id ?? jobId} · ${bits.join(" · ")}`,
    data: envelope,
  };
}
