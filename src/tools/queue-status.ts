import {
  apiFetch,
  CommandError,
  isCommandErrorCode,
  loadConfig,
  rateLimitedMessage,
  REVIEW_EXIT,
  type Config,
  type MergeQueueEntryDto,
} from "mergestorm/client";
import type { ToolPayload } from "./types.js";

function entrySummary(entry: MergeQueueEntryDto): string {
  const prNumber = entry.bounceDetail?.prNumber;
  const repo = `${entry.owner}/${entry.repo}${prNumber ? `#${prNumber}` : ""}`;
  const reason =
    entry.bounceDetail?.kind ?? entry.bounceReason ?? entry.waitReason ?? undefined;
  const sha = entry.bounceDetail?.headSha ?? entry.verifyHeadSha ?? undefined;
  return [
    entry.state,
    repo,
    `stack ${entry.stackId}`,
    reason,
    sha?.slice(0, 7),
  ].filter(Boolean).join(" · ");
}

export async function queueStatus(stackId?: string, cfg?: Config): Promise<ToolPayload> {
  try {
    const resolved = cfg ?? (await loadConfig());
    const id = stackId?.trim();
    const { status, body, retryAfterSeconds } = await apiFetch(
      resolved,
      id
        ? `/api/v1/stacks/queue?stackId=${encodeURIComponent(id)}`
        : "/api/v1/stacks/queue",
    );
    if (status === 404) {
      throw new CommandError(
        "Merge queue route returned 404. Deploy the API.",
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

    const entries = (body as { entries?: MergeQueueEntryDto[] }).entries;
    if (!Array.isArray(entries)) {
      throw new CommandError(
        `Failed to get queue status (HTTP 200): ${JSON.stringify(body)}`,
      );
    }

    if (id) {
      const matchingEntries = entries.filter(
        (candidate) => candidate?.stackId?.toLowerCase() === id.toLowerCase(),
      );
      if (matchingEntries.length === 0) {
        const message = `Queue entry not found for stack: ${id}`;
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
        summary: matchingEntries.map(entrySummary).join("\n"),
        data: { entries: matchingEntries },
      };
    }

    return {
      summary:
        entries.length === 0
          ? "No merge queue entries (live or bounced)"
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
