import type { Config } from "mergestorm/client";
import { agentRequest } from "./agent-request.js";
import { chatTaskNote, chatTaskOf } from "./chat-task.js";
import type { ToolPayload } from "./types.js";

export type PullRequestInput = { owner: string; repo: string; pr_number: number };

export async function reviewStartPr(
  input: PullRequestInput & { head_sha?: string },
  cfg?: Config,
  chatId?: string | null,
): Promise<ToolPayload> {
  const payload = await agentRequest("/api/v1/agents/vortex/review", {
    method: "POST",
    json: {
      owner: input.owner,
      repo: input.repo,
      pr_number: input.pr_number,
      ...(input.head_sha ? { head_sha: input.head_sha } : {}),
      ...(chatId ? { chat_id: chatId } : {}),
    },
  }, cfg);
  const task = chatTaskOf(payload.data.background_task);
  return task ? { ...payload, summary: `${payload.summary} ${chatTaskNote(task)}` } : payload;
}

export async function reviewStopPr(input: PullRequestInput, cfg?: Config): Promise<ToolPayload> {
  return agentRequest("/api/v1/agents/vortex/stop", {
    method: "POST",
    json: { owner: input.owner, repo: input.repo, pr_number: input.pr_number },
  }, cfg);
}
