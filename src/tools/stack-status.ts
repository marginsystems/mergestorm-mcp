import {
  getEnrichedStack,
  listMergeQueueEntries,
  isCommandErrorCode,
  stackBlockers,
  type Config,
  type MergeQueueEntryDto,
} from "mergestorm/client";
import { stackSummary } from "./stack-summary.js";
import type { ToolPayload } from "./types.js";

export async function stackStatus(stackId: string, cfg?: Config): Promise<ToolPayload> {
  try {
    const stack = await getEnrichedStack(stackId, cfg);
    if (!stack) {
      const message = `Stack not found or not owned by the current user: ${stackId}`;
      return {
        summary: message,
        data: {
          error: {
            code: "stack_not_found",
            message,
            stack_id: stackId,
          },
        },
        isError: true,
      };
    }
    const entries: MergeQueueEntryDto[] = await listMergeQueueEntries(cfg, { stackId: stack.id });
    const { attention, issues, currentCandidate } = stackBlockers(stack, entries);
    return {
      summary: stackSummary(stack, entries),
      data: { stack, attention, issues, currentCandidate },
    };
  } catch (err) {
    if (isCommandErrorCode(err, "rate_limited")) {
      return {
        summary: err.message,
        data: {
          error: {
            code: "rate_limited",
            message: err.message,
            retry_after_seconds: err.retryAfterSeconds,
          },
        },
        isError: true,
      };
    }
    throw err;
  }
}
