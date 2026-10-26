import { apiFetch, type Config } from "mergestorm/client";

export type ChatTaskTarget =
  | { kind: "review"; owner: string; repo: string; prNumber: number }
  | { kind: "stack"; stackId: string };

export type ChatTask = { id: string; title: string };

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function breezeChatId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return CHAT_ID.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function chatTaskOf(value: unknown): ChatTask | null {
  if (!value || typeof value !== "object") return null;
  const { id, title } = value as { id?: unknown; title?: unknown };
  return typeof id === "string" && typeof title === "string" ? { id, title } : null;
}

export function chatTaskNote(task: ChatTask): string {
  return `This chat tracks it as background task ${task.id} "${task.title}" and is told the result when it ends. If the user is waiting for the outcome, wait for it before you end the reply, then tell them what actually happened.`;
}

export async function trackInChat(cfg: Config, chatId: string, target: ChatTaskTarget, signal?: AbortSignal): Promise<ChatTask | null> {
  const json = target.kind === "review"
    ? { chat_id: chatId, kind: "review", owner: target.owner, repo: target.repo, pr_number: target.prNumber }
    : { chat_id: chatId, kind: "stack", stack_id: target.stackId };
  try {
    const response = await apiFetch(cfg, "/api/v1/stacks/chat-waits", { method: "POST", json, signal, timeoutMs: 10_000 });
    const body = response.body as { task?: unknown } | null;
    return response.status === 200 ? chatTaskOf(body?.task) : null;
  } catch {
    return null;
  }
}
