import {
  isCommandErrorCode,
  listMergeQueueEntries,
  listStacks,
  type Config,
  type MergeQueueEntryDto,
} from "mergestorm/client";
import { stackSummary } from "./stack-summary.js";
import type { ToolPayload } from "./types.js";

export async function stackList(cfg?: Config): Promise<ToolPayload> {
  try {
    const stacks = await listStacks(cfg);
    const entries: MergeQueueEntryDto[] = await listMergeQueueEntries(cfg);
    return {
      summary:
        stacks.length === 0
          ? "No stacks"
          : stacks.map((stack) => stackSummary(stack, entries)).join("\n"),
      data: { stacks },
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
