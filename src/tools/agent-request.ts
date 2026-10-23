import { apiFetch, CommandError, loadConfig, type Config } from "mergestorm/client";
import type { ToolPayload } from "./types.js";

export async function agentRequest(
  route: string,
  init: { method: "GET" | "POST"; json?: Record<string, unknown> },
  cfg?: Config,
): Promise<ToolPayload> {
  const resolved = cfg ?? (await loadConfig());
  const { status, body, retryAfterSeconds } = await apiFetch(resolved, route, { method: init.method, ...(init.json ? { json: init.json } : {}) });
  const data: Record<string, unknown> = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : { body };
  if (status === 404 && data.error === undefined) {
    throw new CommandError("This Mergestorm server does not offer that action yet.", 1, "not_found");
  }
  const message = typeof data.message === "string" ? data.message : `Mergestorm answered ${status}.`;
  if (status >= 400) {
    return {
      summary: message,
      isError: true,
      data: {
        ...data,
        error: {
          code: typeof data.error === "string" ? data.error : `http_${status}`,
          message,
          ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}),
        },
      },
    };
  }
  return { summary: message, data };
}
