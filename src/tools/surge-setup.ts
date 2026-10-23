import type { Config } from "mergestorm/client";
import { agentRequest } from "./agent-request.js";
import type { ToolPayload } from "./types.js";

export async function surgeSetup(input: { owner: string; repo: string }, cfg?: Config): Promise<ToolPayload> {
  return agentRequest("/api/v1/agents/surge/setup", { method: "POST", json: { owner: input.owner, repo: input.repo } }, cfg);
}
