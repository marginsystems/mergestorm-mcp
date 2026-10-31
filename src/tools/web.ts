import { CommandError, WEB_SEARCH_KINDS, WEB_SEARCH_PAGE_MAX, WEB_SEARCH_RECENCIES, readWebPage, searchWeb, type Config } from "mergestorm/client";
import { z } from "zod";
import type { ToolPayload } from "./types.js";

export const webSearchSchema = {
  query: z.string().trim().min(1).max(400),
  kind: z.enum(WEB_SEARCH_KINDS).optional(),
  recency: z.enum(WEB_SEARCH_RECENCIES).optional(),
  page: z.number().int().min(1).max(WEB_SEARCH_PAGE_MAX).optional(),
};
export const readWebPageSchema = { url: z.string().trim().url().max(2000) };

export type WebApi = { searchWeb: typeof searchWeb; readWebPage: typeof readWebPage };

const liveApi: WebApi = { searchWeb, readWebPage };

async function guarded(run: () => Promise<ToolPayload>): Promise<ToolPayload> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof CommandError ? err.code ?? "web_failed" : "web_failed";
    return {
      summary: message,
      data: { error: { code, message, ...(err instanceof CommandError && err.retryAfterSeconds !== undefined ? { retry_after_seconds: err.retryAfterSeconds } : {}) } },
      isError: true,
    };
  }
}

export function createWebToolHandlers(cfg: Config | undefined, api: WebApi = liveApi) {
  return {
    search: (input: { query: string; kind?: (typeof WEB_SEARCH_KINDS)[number]; recency?: (typeof WEB_SEARCH_RECENCIES)[number]; page?: number }) =>
      guarded(async () => {
        const found = await api.searchWeb(input, cfg);
        return { summary: found.text, data: { query: input.query } };
      }),
    read: (input: { url: string }) =>
      guarded(async () => {
        const page = await api.readWebPage(input.url, cfg);
        return { summary: page.text, data: { url: input.url } };
      }),
  };
}
