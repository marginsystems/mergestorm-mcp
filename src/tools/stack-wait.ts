import {
  loadConfig,
  stackBlockersSummary,
  pollStackWatch,
  StackWatchError,
  StackWatchTimeoutError,
  type Config,
  type StackWatchCursor,
  type StackWatchEnvelope,
} from "mergestorm/client";
import { z } from "zod";
import type { ToolPayload } from "./types.js";

export const stackWaitSchema = {
  stack_id: z.string().trim().min(1),
  timeout_s: z.number().finite().min(0).max(45).default(45),
  enrolled_head_sha: z.string().nullable().optional(),
  after_finished_at: z.string().nullable().optional(),
  bounce_id: z.string().nullable().optional(),
};

export type StackWaitInput = {
  stack_id: string;
  timeout_s?: number;
  enrolled_head_sha?: string | null;
  after_finished_at?: string | null;
  bounce_id?: string | null;
};

export async function stackWait(
  input: StackWaitInput,
  cfg?: Config,
  deps: { pollStackWatch?: typeof pollStackWatch; signal?: AbortSignal } = {},
): Promise<ToolPayload> {
  const args = z.object(stackWaitSchema).parse(input);
  const cursor: StackWatchCursor | undefined =
    args.enrolled_head_sha !== undefined || args.after_finished_at !== undefined || args.bounce_id !== undefined
      ? {
          stackId: args.stack_id,
          enrolledHeadSha: args.enrolled_head_sha ?? null,
          ...(args.after_finished_at !== undefined ? { afterFinishedAt: args.after_finished_at } : {}),
          ...(args.bounce_id !== undefined ? { bounceId: args.bounce_id } : {}),
        }
      : undefined;
  let envelope: StackWatchEnvelope;
  try {
    envelope = await (deps.pollStackWatch ?? pollStackWatch)(cfg ?? await loadConfig(), args.stack_id, {
      timeoutMs: args.timeout_s * 1000,
      cursor,
      signal: deps.signal,
    });
  } catch (err) {
    if (err instanceof StackWatchError) {
      return {
        summary: `Stack ${err.lastEnvelope.stackId} · ${err.lastEnvelope.status}${stackBlockersSummary(err.lastEnvelope.blocker && err.lastEnvelope.prNumber != null ? { prNumber: err.lastEnvelope.prNumber, blocker: err.lastEnvelope.blocker } : null, err.lastEnvelope.issues)}${err.lastEnvelope.assessment === "unavailable" ? " · assessment unavailable" : ""}`,
        data: {
          ...err.lastEnvelope,
          ...(err.retryAfterSeconds !== undefined ? { retry_after_seconds: err.retryAfterSeconds } : {}),
        },
        isError: true,
      };
    }
    if (!(err instanceof StackWatchTimeoutError)) throw err;
    envelope = err.lastEnvelope;
  }
  return {
    summary: `Stack ${envelope.stackId} · ${envelope.status}${stackBlockersSummary(envelope.blocker && envelope.prNumber != null ? { prNumber: envelope.prNumber, blocker: envelope.blocker } : null, envelope.issues)}${envelope.assessment === "unavailable" ? " · assessment unavailable" : ""}`,
    data: envelope,
  };
}
