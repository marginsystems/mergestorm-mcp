import { CommandError, openStackIssue, parseGithubOriginRepo, type Config } from "mergestorm/client";
import { z } from "zod";
import type { ToolPayload } from "./types.js";

export const issueCreateSchema = {
  title: z.string().trim().min(1).max(256),
  body: z.string().max(60_000).optional(),
  labels: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
  owner: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/).optional(),
  repo: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/).optional(),
  cwd: z.string().trim().min(1).optional(),
};
export const hostedIssueCreateSchema = {
  title: issueCreateSchema.title,
  body: issueCreateSchema.body,
  labels: issueCreateSchema.labels,
  owner: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  repo: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/),
};
const inputSchema = z.object(issueCreateSchema);
export type IssueCreateInput = z.infer<typeof inputSchema>;

export type IssueCreateDeps = {
  openStackIssue?: typeof openStackIssue;
  parseGithubOriginRepo?: typeof parseGithubOriginRepo;
};

export async function issueCreate(input: IssueCreateInput, cfg?: Config, deps: IssueCreateDeps = {}): Promise<ToolPayload> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || Boolean(parsed.data.owner) !== Boolean(parsed.data.repo)) {
    const message = "issue_create needs a one-line title of at most 256 characters, and owner and repo together";
    return { summary: message, data: { error: { code: "invalid_input", message } }, isError: true };
  }
  const { title, body, labels, owner, repo, cwd } = parsed.data;
  try {
    const target = owner && repo ? { owner, repo } : (deps.parseGithubOriginRepo ?? parseGithubOriginRepo)(cwd);
    if (!target) {
      const message = "Could not read a GitHub owner/repo from origin. Pass owner and repo.";
      return { summary: message, data: { error: { code: "invalid_input", message } }, isError: true };
    }
    const issue = await (deps.openStackIssue ?? openStackIssue)(
      { owner: target.owner, repo: target.repo, title, body: body ?? "", labels: labels ?? [] },
      cfg,
    );
    return {
      summary: `${issue.created ? "Opened" : "Already open:"} ${target.owner}/${target.repo}#${issue.number} ${issue.url}. Put "Fixes #${issue.number}" in the commit or pull request body.`,
      data: { owner: target.owner, repo: target.repo, ...issue },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      summary: message,
      data: {
        error: {
          code: err instanceof CommandError ? err.code ?? "issue_create_failed" : "issue_create_failed",
          message,
          ...(err instanceof CommandError && err.retryAfterSeconds !== undefined
            ? { retry_after_seconds: err.retryAfterSeconds } : {}),
        },
      },
      isError: true,
    };
  }
}
