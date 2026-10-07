import { adoptStack, CommandError, stackWatchObligation, type Config } from "mergestorm/client";
import { z } from "zod";
import { stackSetPatch } from "./stack-set.js";
import { withWatchText } from "./stack-wait.js";
import type { ToolPayload } from "./types.js";

export const stackAdoptSchema = {
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  pr_number: z.number().int().min(1),
  auto_land: z.boolean().optional(),
  auto_review: z.boolean().nullable().optional(),
  auto_patch: z.boolean().nullable().optional(),
  auto_resolve_conflicts: z.boolean().nullable().optional(),
  auto_fix_ci: z.boolean().nullable().optional(),
};
const inputSchema = z.object(stackAdoptSchema);
export type StackAdoptInput = z.infer<typeof inputSchema>;

export async function stackAdopt(input: StackAdoptInput, cfg?: Config): Promise<ToolPayload> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const message = "stack_adopt requires owner, repo, a positive pr_number, and valid policy values";
    return { summary: message, data: { error: { code: "invalid_input", message } }, isError: true };
  }
  const { owner, repo, pr_number } = parsed.data;
  try {
    const result = await adoptStack(
      owner,
      repo,
      pr_number,
      cfg,
      stackSetPatch(parsed.data),
    );
    const summary = `Adopted stack for ${owner}/${repo}#${pr_number}`;
    const stackId = typeof result === "object" && result !== null
      ? (result as { stack?: { id?: unknown } }).stack?.id
      : undefined;
    if (typeof stackId !== "string" || !stackId) {
      return { summary, data: { owner, repo, pr_number, result } };
    }
    const watch = stackWatchObligation({ stackId, terminal: null, unread: true, freshCursor: true });
    return {
      summary: withWatchText(watch, summary),
      data: { owner, repo, pr_number, result, watch },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      summary: message,
      data: {
        error: {
          code: err instanceof CommandError ? err.code ?? "stack_adopt_failed" : "stack_adopt_failed",
          message,
          ...(err instanceof CommandError ? { exit_code: err.exitCode } : {}),
          ...(err instanceof CommandError && err.reason !== undefined ? { reason: err.reason } : {}),
          ...(err instanceof CommandError && err.retryAfterSeconds !== undefined
            ? { retry_after_seconds: err.retryAfterSeconds } : {}),
        },
      },
      isError: true,
    };
  }
}
