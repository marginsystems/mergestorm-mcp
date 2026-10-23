import type { Config } from "mergestorm/client";
import { agentRequest } from "./agent-request.js";
import type { ToolPayload } from "./types.js";

export const CYCLONE_TASKS = ["fix_findings", "fix_ci", "resolve_conflicts", "build"] as const;
export type CycloneTask = (typeof CYCLONE_TASKS)[number];

export const CYCLONE_JOB_WAIT_DEFAULT_S = 45;
export const CYCLONE_JOB_WAIT_MAX_S = 100;
export const CYCLONE_JOB_POLL_MS = 5_000;
export const CYCLONE_JOB_TERMINAL_STATES = ["pushed", "completed", "failed"] as const;

export const CYCLONE_START_WAIT_NOTE = `Wait for it now: call cyclone_job with this dispatch_id and timeout_s ${CYCLONE_JOB_WAIT_DEFAULT_S}, again while it is queued or running, then tell the user what Cyclone pushed or why it failed.`;
export const CHAT_WAKE_CYCLONE_NOTE = "If your reply ends before Cyclone finishes, this chat is woken with the job's result.";
export const CYCLONE_JOB_STILL_RUNNING_NOTE = `Cyclone is not done. Call cyclone_job again with this dispatch_id and timeout_s ${CYCLONE_JOB_WAIT_DEFAULT_S}, and report the result once it is pushed, completed or failed.`;

export type CycloneStartInput = {
  task: CycloneTask;
  owner: string;
  repo: string;
  pr_number?: number;
  failing_check?: string;
  brief?: string;
};

export async function cycloneStart(input: CycloneStartInput, cfg?: Config, chatId?: string | null): Promise<ToolPayload> {
  const payload = await agentRequest("/api/v1/agents/cyclone/jobs", {
    method: "POST",
    json: {
      task: input.task,
      owner: input.owner,
      repo: input.repo,
      ...(input.pr_number !== undefined ? { pr_number: input.pr_number } : {}),
      ...(input.failing_check ? { failing_check: input.failing_check } : {}),
      ...(input.brief ? { brief: input.brief } : {}),
      ...(chatId ? { chat_id: chatId } : {}),
    },
  }, cfg);
  if (payload.isError || typeof payload.data.dispatch_id !== "string" || isCycloneJobTerminal(payload.data)) return payload;
  return { ...payload, summary: [payload.summary, CYCLONE_START_WAIT_NOTE, ...(payload.data.chat_wake ? [CHAT_WAKE_CYCLONE_NOTE] : [])].join(" ") };
}

export function isCycloneJobTerminal(job: Record<string, unknown>): boolean {
  return (CYCLONE_JOB_TERMINAL_STATES as readonly unknown[]).includes(job.state);
}

export function cycloneJobSummary(job: Record<string, unknown>): string {
  const target = job.pr_number ? `${job.owner}/${job.repo}#${job.pr_number}` : `${job.owner}/${job.repo}`;
  const parts = [`Cyclone ${job.task ?? "job"} on ${target}: ${job.state}`];
  if (typeof job.outcome === "string" && job.outcome) parts[0] += ` (${job.outcome})`;
  if (typeof job.result_sha === "string" && job.result_sha) parts.push(`pushed ${job.result_sha.slice(0, 10)}`);
  if (typeof job.detail === "string" && job.detail) parts.push(job.detail);
  return parts.join(". ");
}

export type CycloneJobWaitDeps = {
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
};

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function cycloneJob(dispatchId: string, cfg?: Config, timeoutS = 0, deps: CycloneJobWaitDeps = {}): Promise<ToolPayload> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepFor;
  const deadline = now() + Math.min(Math.max(timeoutS, 0), CYCLONE_JOB_WAIT_MAX_S) * 1000;
  const route = `/api/v1/agents/cyclone/jobs/${encodeURIComponent(dispatchId)}`;
  for (;;) {
    const payload = await agentRequest(route, { method: "GET" }, cfg);
    if (payload.isError) return payload;
    if (isCycloneJobTerminal(payload.data)) return { ...payload, summary: cycloneJobSummary(payload.data) };
    const left = deadline - now();
    if (left <= 0 || deps.signal?.aborted) return { ...payload, summary: `${cycloneJobSummary(payload.data)}. ${CYCLONE_JOB_STILL_RUNNING_NOTE}` };
    await sleep(Math.min(deps.pollMs ?? CYCLONE_JOB_POLL_MS, left), deps.signal);
  }
}
