import type { Config } from "mergestorm/client";
import { agentRequest } from "./agent-request.js";
import { REVIEW_START_WAIT_NOTE } from "./chat-wake.js";
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
  return payload.data.chat_wake ? { ...payload, summary: `${payload.summary} ${REVIEW_START_WAIT_NOTE}` } : payload;
}

export async function reviewStopPr(input: PullRequestInput, cfg?: Config): Promise<ToolPayload> {
  return agentRequest("/api/v1/agents/vortex/stop", {
    method: "POST",
    json: { owner: input.owner, repo: input.repo, pr_number: input.pr_number },
  }, cfg);
}
