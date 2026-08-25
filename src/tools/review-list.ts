import { listJobs, toReviewJobEnvelope, type Config } from "mergestorm/client";
import type { ToolPayload } from "./types.js";

export async function reviewList(limit = 10, cfg?: Config): Promise<ToolPayload> {
  const items = await listJobs(limit, cfg);
  const envelopes = items.map((row) => toReviewJobEnvelope(row));
  const n = envelopes.length;
  return {
    summary: n === 0 ? "No review jobs" : `${n} review job${n === 1 ? "" : "s"}`,
    data: { items: envelopes },
  };
}
