import {
  CommandError,
  ReviewPollTimeoutError,
  loadConfig,
  pollReview,
  type Config,
} from "mergestorm/client";
import { payloadFromRateLimit, payloadFromRow } from "./envelope.js";
import { waitTimeoutMs } from "./review-submit.js";
import type { ToolPayload } from "./types.js";

export type ReviewWaitOptions = {
  pollIntervalMs?: number;
};

export async function reviewWait(
  jobId: string,
  timeout_s?: number,
  cfg?: Config,
  opts: ReviewWaitOptions = {},
): Promise<ToolPayload> {
  const resolved = cfg ?? (await loadConfig());
  const id = jobId.trim();
  if (!id) {
    throw new CommandError("job_id is required", 2, "usage");
  }
  try {
    const row = await pollReview(resolved, id, {
      timeoutMs: waitTimeoutMs(timeout_s),
      intervalMs: opts.pollIntervalMs,
    });
    return payloadFromRow(row, { jobId: id });
  } catch (err) {
    if (err instanceof ReviewPollTimeoutError) {
      return payloadFromRow(err.lastRow, {
        jobId: id,
        status: err.lastRow.status ?? "in_progress",
        error: "Timed out waiting for review.",
      });
    }
    const rateLimited = payloadFromRateLimit(err, id);
    if (rateLimited) return rateLimited;
    throw err;
  }
}
