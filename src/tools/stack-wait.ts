import {
  loadConfig,
  stackBlockersSummary,
  pollStackWatch,
  StackWatchError,
  StackWatchTimeoutError,
  stackWatchBackgroundCommand,
  stackWatchObligation,
  type Config,
  type StackRepairHint,
  type StackWatchObligation,
  type StackWatchNextArgs,
  type StackWatchCursor,
  type StackWatchEnvelope,
} from "mergestorm/client";
import { z } from "zod";
import type { ToolPayload } from "./types.js";
import { chatTaskNote, trackInChat } from "./chat-task.js";

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

export function repairSummary(repair: StackRepairHint | null | undefined): string {
  if (!repair) return "";
  const files = "files" in repair && repair.files.length ? ` Files: ${repair.files.join(", ")}.` : "";
  const note = "note" in repair && repair.note ? ` ${repair.note}` : "";
  return `\nRepair #${repair.prNumber} (${repair.kind}).${files} ${repair.steps}${note}`;
}

export function withWatchText(watch: StackWatchObligation, body: string): string {
  return `${watch.message}\n\n${body}`;
}

export type HostedStackWatch = Omit<StackWatchObligation, "next"> & { next: { tool: "stack_wait"; args: StackWatchNextArgs } | null };

const KEEP_EARLIER_CURSOR = "If you already hold a cursor from an earlier stack_wait on this stack, keep passing that cursor instead.";

export function hostedStackWatch(watch: StackWatchObligation): HostedStackWatch {
  if (watch.done) {
    return {
      ...watch,
      next: null,
      message: watch.reason === "not_found"
        ? "No stack with this id exists for this account. Mergestorm deletes a stack once none of its layers is open, which can mean merged or closed, so landing is unconfirmed: check on GitHub that each PR is merged before reporting it landed. The watch is done."
        : watch.message,
    };
  }
  const args = watch.next?.args;
  const attention = watch.reason === "attention";
  const retry = watch.reason === "rate_limited" ? " Wait retry_after_seconds first." : "";
  const failed = watch.reason === "failed" ? " This read failed; if the next one fails too, tell the human the stack is no longer watched." : "";
  const keep = watch.message.includes(KEEP_EARLIER_CURSOR) ? ` ${KEEP_EARLIER_CURSOR}` : "";
  const resume = args
    ? attention
      ? ` After the blocker is handled, call stack_wait ${JSON.stringify(args)}.`
      : ` Next call: stack_wait ${JSON.stringify(args)}.`
    : "";
  return {
    ...watch,
    next: args && !attention ? { tool: "stack_wait", args } : null,
    message: `This stack is not landed and the watch is not done.${retry}${failed}${resume}${keep}`,
  };
}

type McpTextResult = { isError?: boolean; content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> };

type HostedStackRepair = Omit<StackRepairHint, "steps" | "note">;

function hostedStackRepair(repair: StackRepairHint): HostedStackRepair {
  const { steps: _steps, note: _note, findings: _findings, ...facts } = repair as StackRepairHint & { note?: string; findings?: string };
  return facts;
}

function hostedRepairSummary(repair: StackRepairHint): string {
  const files = "files" in repair && repair.files.length ? ` Files: ${repair.files.join(", ")}.` : "";
  const breeze = "publishedBy" in repair && repair.publishedBy === "breeze"
    ? ` ${repair.branch} is a Breeze branch${repair.liveParent ? ` on ${repair.liveParent}` : ""}: open_pull_request publishes it with single-parent commits only, so a merge commit cannot be published.`
    : "";
  return `\nRepair #${repair.prNumber} (${repair.kind}).${files}${breeze}`;
}

export function hostedToolResult<T extends McpTextResult>(result: T): T {
  const data = result.structuredContent;
  const watch = data?.watch as StackWatchObligation | undefined;
  const repair = data?.repair as StackRepairHint | null | undefined;
  const hasWatch = !!watch && typeof watch.message === "string";
  const hasRepair = !!repair && typeof repair.steps === "string";
  if (!data || (!hasWatch && !hasRepair)) return result;
  let text = result.content[0]?.text ?? "";
  const structured: Record<string, unknown> = { ...data };
  if (hasWatch) {
    const hosted = hostedStackWatch(watch);
    structured.watch = hosted;
    if (text.startsWith(watch.message)) text = `${hosted.message}${text.slice(watch.message.length)}`;
  }
  if (hasRepair) {
    const hosted = hostedStackRepair(repair);
    structured.repair = hosted;
    text = text.replace(repairSummary(repair), hostedRepairSummary(repair));
  }
  return { ...result, content: [{ type: "text", text }, { type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

function envelopeWatch(envelope: StackWatchEnvelope): StackWatchObligation {
  return envelope.watch ?? stackWatchObligation({
    stackId: envelope.stackId, terminal: null, cursor: envelope.cursor, status: envelope.status,
  });
}

function stackWaitSummary(envelope: StackWatchEnvelope, hosted = false): string {
  return withWatchText(envelopeWatch(envelope), `${stackWaitStatusLine(envelope, hosted)}${repairSummary(envelope.repair)}`);
}

function stackWaitStatusLine(envelope: StackWatchEnvelope, hosted: boolean): string {
  const base = `Stack ${envelope.stackId} · ${envelope.status}${stackBlockersSummary(envelope.blocker && envelope.prNumber != null ? { prNumber: envelope.prNumber, blocker: envelope.blocker } : null, envelope.issues, envelope.busy, envelope.landGatePending, envelope.actAfter ?? null, envelope.queueWait ?? null)}${envelope.assessment === "unavailable" ? " · assessment unavailable" : ""}`;
  if (envelopeWatch(envelope).done || (envelope.status !== "waiting" && envelope.status !== "in_progress")) return base;
  const selectors = [
    `stack_id ${JSON.stringify(envelope.cursor.stackId)}`,
    `enrolled_head_sha ${JSON.stringify(envelope.cursor.enrolledHeadSha)}`,
    ...(envelope.cursor.afterFinishedAt !== undefined ? [`after_finished_at ${JSON.stringify(envelope.cursor.afterFinishedAt)}`] : []),
    ...(envelope.cursor.bounceId !== undefined ? [`bounce_id ${JSON.stringify(envelope.cursor.bounceId)}`] : []),
  ];
  const background = hosted ? "" : `only with a confirmed host notification that resumes this task, run ${stackWatchBackgroundCommand(envelope.stackId, envelope.cursor)} as a background command and end your turn; otherwise `;
  return `${base} · watch not finished: ${background}call stack_wait again with timeout_s 45 and the same cursor: ${selectors.join(", ")}`;
}

export async function stackWait(
  input: StackWaitInput,
  cfg?: Config,
  deps: { pollStackWatch?: typeof pollStackWatch; signal?: AbortSignal; chatId?: string; hosted?: boolean } = {},
): Promise<ToolPayload> {
  const args = z.object(stackWaitSchema).parse(input);
  const config = cfg ?? await loadConfig();
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
    envelope = await (deps.pollStackWatch ?? pollStackWatch)(config, args.stack_id, {
      timeoutMs: args.timeout_s * 1000,
      cursor,
      signal: deps.signal,
    });
  } catch (err) {
    if (err instanceof StackWatchError) {
      const envelope = { ...err.lastEnvelope, watch: envelopeWatch(err.lastEnvelope) };
      return {
        summary: stackWaitSummary(envelope, deps.hosted),
        data: {
          ...envelope,
          ...(err.retryAfterSeconds !== undefined ? { retry_after_seconds: err.retryAfterSeconds } : {}),
        },
        isError: !envelope.watch.done,
      };
    }
    if (!(err instanceof StackWatchTimeoutError)) throw err;
    envelope = err.lastEnvelope;
  }
  const sealed = { ...envelope, watch: envelopeWatch(envelope) };
  const task = deps.chatId && !sealed.watch.done
    ? await trackInChat(config, deps.chatId, { kind: "stack", stackId: sealed.stackId }, deps.signal)
    : null;
  return {
    summary: task ? `${stackWaitSummary(sealed, deps.hosted)}\n\n${chatTaskNote(task)}` : stackWaitSummary(sealed, deps.hosted),
    data: task ? { ...sealed, background_task: task } : sealed,
  };
}
