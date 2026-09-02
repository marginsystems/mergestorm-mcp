import {
  apiFetch,
  CommandError,
  isCommandErrorCode,
  loadConfig,
  rateLimitedMessage,
  REVIEW_EXIT,
  type Config,
} from "mergestorm/client";
import type { ToolPayload } from "./types.js";

type QueueEntry = {
  id?: string;
  stackId?: string;
  owner?: string;
  repo?: string;
  state?: string;
  position?: number;
};

function entrySummary(entry: QueueEntry): string {
  const repo = entry.owner && entry.repo ? `${entry.owner}/${entry.repo}` : "unknown repo";
  const position = entry.position === undefined ? "queue" : `#${entry.position}`;
  return `${position} · ${repo} · stack ${entry.stackId ?? "unknown"} · ${entry.state ?? "unknown"}`;
}

export async function queueStatus(stackId?: string, cfg?: Config): Promise<ToolPayload> {
  try {
    const resolved = cfg ?? (await loadConfig());
    const { status, body, retryAfterSeconds } = await apiFetch(
      resolved,
      "/api/v1/stacks/queue",
    );
    if (status === 404) {
      throw new CommandError(
        "Merge queue API is not available on this server yet. Deploy the API update or use the dashboard.",
      );
    }
    if (status === 429) {
      throw new CommandError(
        rateLimitedMessage(retryAfterSeconds),
        REVIEW_EXIT.rate_limited,
        "rate_limited",
        { retryAfterSeconds },
      );
    }
    if (status !== 200) {
      throw new CommandError(
        `Failed to get queue status (HTTP ${status}): ${JSON.stringify(body)}`,
      );
    }

    const entries = (body as { entries?: QueueEntry[] }).entries;
    if (!Array.isArray(entries)) {
      throw new CommandError(
        `Failed to get queue status (HTTP 200): ${JSON.stringify(body)}`,
      );
    }

    const id = stackId?.trim();
    if (id) {
      const entry = entries.find((candidate) => candidate?.stackId === id);
      if (!entry) {
        const message = `Live queue entry not found for stack: ${id}`;
        return {
          summary: message,
          data: {
            error: {
              code: "queue_entry_not_found",
              message,
              stack_id: id,
            },
          },
          isError: true,
        };
      }
      return {
        summary: entrySummary(entry),
        data: { entry },
      };
    }

    return {
      summary:
        entries.length === 0
          ? "No live merge queue entries"
          : entries.map(entrySummary).join("\n"),
      data: { entries },
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
