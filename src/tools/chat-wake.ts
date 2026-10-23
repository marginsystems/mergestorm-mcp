import { apiFetch, type Config } from "mergestorm/client";

export type ChatWakeTarget =
  | { kind: "vortex"; owner: string; repo: string; prNumber: number; headSha: string | null; minPass: number | null }
  | { kind: "stack"; stackId: string };

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function breezeChatId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return CHAT_ID.test(trimmed) ? trimmed.toLowerCase() : null;
}

export type ChatWake = { id: string; result: "waiting" | "existing" | "finished" };

export const CHAT_WAKE_REVIEW_NOTE = "Keep waiting: call review_wait_pr again until the review finishes, then tell the user its verdict and findings. If your reply ends first, this chat is woken with the review's result.";
export const REVIEW_START_WAIT_NOTE = "Wait for it now: call review_wait_pr for this pull request until the review finishes, then tell the user its verdict and findings. If your reply ends first, this chat is woken with the review's result.";
export const CHAT_WAKE_STACK_NOTE = "If your reply ends before the stack is done, this chat is woken when the stack lands, is bounced out of the merge queue, or is archived.";

export async function registerChatWake(cfg: Config, chatId: string, target: ChatWakeTarget, signal?: AbortSignal): Promise<ChatWake | null> {
  const json = target.kind === "vortex"
    ? { chat_id: chatId, kind: "vortex", owner: target.owner, repo: target.repo, pr_number: target.prNumber, head_sha: target.headSha, min_pass: target.headSha ? target.minPass : null }
    : { chat_id: chatId, kind: "stack", stack_id: target.stackId };
  try {
    const response = await apiFetch(cfg, "/api/v1/stacks/chat-waits", { method: "POST", json, signal, timeoutMs: 10_000 });
    const body = response.body as { result?: unknown; id?: unknown } | null;
    if (response.status !== 200 || !body || typeof body.id !== "string") return null;
    if (body.result !== "waiting" && body.result !== "existing" && body.result !== "finished") return null;
    return { id: body.id, result: body.result };
  } catch {
    return null;
  }
}
