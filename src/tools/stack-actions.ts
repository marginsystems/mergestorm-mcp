import { enqueueStack, loadConfig, restackStack, stackWatchObligation, type Config } from "mergestorm/client";
import { chatTaskNote, trackInChat } from "./chat-task.js";
import { withWatchText } from "./stack-wait.js";
import type { ToolPayload } from "./types.js";

export async function stackRestack(stackId: string, cfg?: Config): Promise<ToolPayload> {
  const result = await restackStack(stackId, cfg);
  const watch = stackWatchObligation({ stackId, terminal: null, unread: true, freshCursor: true });
  return {
    summary: withWatchText(watch, `Restacked stack ${stackId}: its layer branches were rebased onto their parents and pushed`),
    data: { stack_id: stackId, result, watch },
  };
}

export async function stackEnqueue(stackId: string, cfg?: Config, chatId?: string | null): Promise<ToolPayload> {
  const resolved = cfg ?? (await loadConfig());
  const result = await enqueueStack(stackId, resolved);
  const watch = stackWatchObligation({ stackId, terminal: null, unread: true, freshCursor: true });
  const task = chatId ? await trackInChat(resolved, chatId, { kind: "stack", stackId }) : null;
  const summary = withWatchText(watch, `Sent stack ${stackId} to the Mergestorm merge queue`);
  return {
    summary: task ? `${summary} ${chatTaskNote(task)}` : summary,
    data: { stack_id: stackId, result, watch, ...(task ? { background_task: task } : {}) },
  };
}
