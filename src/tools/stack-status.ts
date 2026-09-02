import { getEnrichedStack, isCommandErrorCode, type Config } from "mergestorm/client";
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
    return {
      summary: stackSummary(stack),
      data: { stack },
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
