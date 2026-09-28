import {
  getEnrichedStack,
  listMergeQueueEntries,
  isCommandErrorCode,
  stackBlockers,
  stackTerminalReason,
  stackWatchObligation,
  type Config,
  type MergeQueueEntryDto,
} from "mergestorm/client";
import { repairSummary, withWatchText } from "./stack-wait.js";
import { stackSummary } from "./stack-summary.js";
import type { ToolPayload } from "./types.js";

export async function stackStatus(stackId: string, cfg?: Config): Promise<ToolPayload> {
  try {
    const stack = await getEnrichedStack(stackId, cfg);
    if (!stack) {
      const message = `Stack not found or not owned by the current user: ${stackId}`;
      const watch = stackWatchObligation({ stackId, terminal: "not_found" });
      return {
        summary: withWatchText(watch, message),
        data: {
          error: {
            code: "stack_not_found",
            message,
            stack_id: stackId,
          },
          watch,
        },
        isError: true,
      };
    }
    const entries: MergeQueueEntryDto[] = await listMergeQueueEntries(cfg, { stackId: stack.id });
    const { attention, held, issues, currentCandidate, busy, agents, repair, landGatePending } = stackBlockers(stack, entries);
    const watch = stackWatchObligation({
      stackId: stack.id,
      terminal: stackTerminalReason(stack),
      cursor: { enrolledHeadSha: currentCandidate?.headSha ?? null },
      attention: attention ? { prNumber: attention.prNumber, blocker: attention.blocker } : null,
      freshCursor: true,
    });
    return {
      summary: withWatchText(watch, `${stackSummary(stack, entries)}${repairSummary(repair)}`),
      data: { stack, attention, held, issues, currentCandidate, busy, agents, repair, landGatePending, watch },
    };
  } catch (err) {
    if (isCommandErrorCode(err, "rate_limited")) {
      const watch = stackWatchObligation({
        stackId, terminal: null, status: "rate_limited", retryAfterSeconds: err.retryAfterSeconds, freshCursor: true,
      });
      return {
        summary: withWatchText(watch, err.message),
        data: {
          error: {
            code: "rate_limited",
            message: err.message,
            retry_after_seconds: err.retryAfterSeconds,
          },
          watch,
        },
        isError: true,
      };
    }
    throw err;
  }
}
