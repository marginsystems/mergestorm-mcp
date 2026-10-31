import {
  CommandError,
  publishWorkingBranch,
  stackWatchObligation,
  workingBranchPublication,
  type Config,
} from "mergestorm/client";
import { z } from "zod";
import { withIssueReviewHint } from "./issue-review-wait.js";
import { withWatchText } from "./stack-wait.js";
import type { ToolPayload } from "./types.js";

const target = {
  cwd: z.string().trim().min(1).optional(),
  owner: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
};

export const stackPublishSchema = {
  ...target,
  base: z.string().trim().min(1).optional(),
  extend: z.boolean().optional(),
  title: z.string().trim().min(1).max(256).optional(),
  body: z.string().max(60_000).optional(),
  replace_head: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  auto_land: z.boolean().optional(),
};
export const stackPublishStatusSchema = target;

const publishInput = z.object(stackPublishSchema);
const statusInput = z.object(stackPublishStatusSchema);
export type StackPublishInput = z.infer<typeof publishInput>;
export type StackPublishStatusInput = z.infer<typeof statusInput>;

type PublishDeps = Parameters<typeof publishWorkingBranch>[1];
type StatusDeps = Parameters<typeof workingBranchPublication>[1];

function failure(err: unknown, fallback: string): ToolPayload {
  const message = err instanceof Error ? err.message : String(err);
  return {
    summary: withIssueReviewHint(err, message),
    data: {
      error: {
        code: err instanceof CommandError ? err.code ?? fallback : fallback,
        message,
        ...(err instanceof CommandError && err.retryAfterSeconds !== undefined
          ? { retry_after_seconds: err.retryAfterSeconds } : {}),
      },
    },
    isError: true,
  };
}

function targetOf(input: StackPublishStatusInput, cfg?: Config) {
  return {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(cfg ? { cfg } : {}),
  };
}

export async function stackPublish(input: StackPublishInput, cfg?: Config, deps?: PublishDeps): Promise<ToolPayload> {
  const parsed = publishInput.safeParse(input);
  if (!parsed.success || Boolean(parsed.data.owner) !== Boolean(parsed.data.repo)) {
    const message = "stack_publish takes owner and repo together, and replace_head as a full 40-character commit SHA";
    return { summary: message, data: { error: { code: "invalid_input", message } }, isError: true };
  }
  try {
    const result = await publishWorkingBranch(
      {
        ...targetOf(parsed.data, cfg),
        ...(parsed.data.base ? { base: parsed.data.base } : {}),
        ...(parsed.data.extend ? { extend: true } : {}),
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
        ...(parsed.data.replace_head ? { replaceHead: parsed.data.replace_head } : {}),
        ...(typeof parsed.data.auto_land === "boolean" ? { autoLand: parsed.data.auto_land } : {}),
      },
      deps,
    );
    const watch = stackWatchObligation({ stackId: result.stack.id, terminal: null, unread: true, freshCursor: true });
    const moved = result.branchCreated ? "created" : result.branchUpdated ? "updated" : "already current";
    return {
      summary: withWatchText(
        watch,
        `Published ${result.owner}/${result.repo} ${result.branch} (${moved}) at ${result.head.sha}, PR #${result.pr.number} (${result.stacked ? `a layer stacked on ${result.baseBranch}` : `a single PR onto ${result.baseBranch}`}), stack ${result.stack.id}`,
      ),
      data: { result, watch },
    };
  } catch (err) {
    return failure(err, "stack_publish_failed");
  }
}

export async function stackPublishStatus(input: StackPublishStatusInput, cfg?: Config, deps?: StatusDeps): Promise<ToolPayload> {
  const parsed = statusInput.safeParse(input);
  if (!parsed.success || Boolean(parsed.data.owner) !== Boolean(parsed.data.repo)) {
    const message = "stack_publish_status takes owner and repo together";
    return { summary: message, data: { error: { code: "invalid_input", message } }, isError: true };
  }
  try {
    const status = await workingBranchPublication(targetOf(parsed.data, cfg), deps);
    return {
      summary: `${status.owner}/${status.repo} ${status.branch}: ${status.state}${status.head ? ` at ${status.head.sha}` : ""}${status.pr ? `, PR #${status.pr.number}` : ""}${status.stack ? `, stack ${status.stack.id}` : ""}`,
      data: { status },
    };
  } catch (err) {
    return failure(err, "stack_publish_status_failed");
  }
}
