import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CommandError } from "mergestorm/client";
import { credits } from "./tools/credits.js";
import { queueStatus } from "./tools/queue-status.js";
import { reviewGetPr } from "./tools/review-get-pr.js";
import { reviewGet } from "./tools/review-get.js";
import { reviewList } from "./tools/review-list.js";
import { reviewSubmit } from "./tools/review-submit.js";
import { reviewWaitPr } from "./tools/review-wait-pr.js";
import { reviewWait } from "./tools/review-wait.js";
import { settingsGet } from "./tools/settings-get.js";
import { settingsSet } from "./tools/settings-set.js";
import { stackList } from "./tools/stack-list.js";
import { stackStatus } from "./tools/stack-status.js";
import type { ToolPayload } from "./tools/types.js";
import { whoami } from "./tools/whoami.js";

export const MCP_SERVER_NAME = "mergestorm";
export const MCP_SERVER_VERSION = "0.1.3";

export const MCP_TOOL_NAMES = [
  "whoami",
  "credits",
  "review_list",
  "review_get",
  "review_get_pr",
  "review_submit",
  "review_wait",
  "review_wait_pr",
  "stack_list",
  "stack_status",
  "queue_status",
  "settings_get",
  "settings_set",
] as const;

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripNulls(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (val !== null && val !== undefined) out[key] = stripNulls(val);
    }
    return out;
  }
  return value;
}

function ok(payload: ToolPayload) {
  return {
    ...(payload.isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: payload.summary }],
    structuredContent: stripNulls(payload.data) as Record<string, unknown>,
  };
}

function fail(err: unknown) {
  const message =
    err instanceof CommandError
      ? err.code
        ? `Mergestorm request failed (${err.code}): ${err.message}.`
        : err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function createMergestormMcpServer(): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });
  // MCP SDK + zod generic inference hits TS2589 on several schemas; keep
  // runtime registerTool, drop the instantiation from our typecheck.
  const addTool = server.registerTool.bind(server) as (
    name: string,
    config: { title?: string; description?: string; inputSchema?: Record<string, unknown> },
    cb: (...args: any[]) => unknown,
  ) => void;

  addTool(
    "whoami",
    {
      title: "Who am I",
      description: "Current Mergestorm API key prefix, plan, and API base.",
    },
    async () => {
      try {
        return ok(await whoami());
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "credits",
    {
      title: "Credits",
      description: "Current standard-credit usage and reset time.",
    },
    async () => {
      try {
        return ok(await credits());
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "review_list",
    {
      title: "List reviews",
      description: "List recent Mergestorm review jobs as job envelopes.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ limit }) => {
      try {
        return ok(await reviewList(limit));
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "review_get",
    {
      title: "Get review",
      description:
        "Fetch one Mergestorm review job as a job envelope. On rate_limited, wait retry_after_seconds before trying again.",
      inputSchema: {
        job_id: z.string().min(1),
      },
    },
    async ({ job_id }) => {
      try {
        return ok(await reviewGet(job_id));
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "review_get_pr",
    {
      title: "Get GitHub PR Vortex review",
      description:
        "Fetch the latest GitHub PR Vortex pass from the DB-only endpoint. This tool is read-only. On rate_limited, wait retry_after_seconds before trying again.",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pr_number: z.number().int().min(1),
      },
    },
    async ({ owner, repo, pr_number }) => {
      try {
        return ok(await reviewGetPr(owner, repo, pr_number));
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "review_submit",
    {
      title: "Submit review",
      description:
        "Submit a local git diff (or an explicit diff) as a Mergestorm review job. Default waits up to 300s. On rate_limited, wait retry_after_seconds and inspect or wait for an in-flight review before resubmitting. specialists may be security, performance, architecture, tests, data, api, frontend. governance and seam cannot be requested.",
      inputSchema: {
        cwd: z.string().optional(),
        base: z.string().optional(),
        head: z.string().optional(),
        diff: z.string().optional(),
        router: z.enum(["off", "standard", "max", "manual"]).optional(),
        specialists: z.array(z.string().min(1)).max(5).optional(),
        context: z.string().optional(),
        context_files: z.array(z.string().min(1)).max(10).optional(),
        thread: z.string().min(1).max(120).optional(),
        idempotency_key: z.string().min(1).max(128).optional(),
        wait: z.boolean().optional(),
        timeout_s: z.number().positive().max(300).optional(),
      },
    },
    async (args) => {
      try {
        return ok(await reviewSubmit(args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "review_wait",
    {
      title: "Wait for review",
      description:
        "Poll one Mergestorm review job until it finishes, return in_progress after 300s, or return rate_limited with retry_after_seconds.",
      inputSchema: {
        job_id: z.string().min(1),
        timeout_s: z.number().positive().max(300).optional(),
      },
    },
    async ({ job_id, timeout_s }) => {
      try {
        return ok(await reviewWait(job_id, timeout_s));
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "review_wait_pr",
    {
      title: "Wait for GitHub PR Vortex review",
      description:
        "Poll the DB-only GitHub PR Vortex pass until it rests. This tool is read-only. On timeout, returns in_progress. On rate_limited, wait retry_after_seconds before trying again.",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pr_number: z.number().int().min(1),
        after_sha: z.string().optional(),
        timeout_s: z.number().positive().max(300).optional(),
      },
    },
    async ({ owner, repo, pr_number, after_sha, timeout_s }) => {
      try {
        return ok(
          await reviewWaitPr(
            owner,
            repo,
            pr_number,
            after_sha,
            timeout_s,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "stack_list",
    {
      title: "List stacks",
      description:
        "List the current user's Mergestorm stacks. This tool is read-only.",
    },
    async () => {
      try {
        return ok(await stackList());
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "stack_status",
    {
      title: "Get stack status",
      description:
        "Fetch one owned Mergestorm stack with enriched checks and agent state. This tool is read-only.",
      inputSchema: {
        stack_id: z.string().min(1),
      },
    },
    async ({ stack_id }) => {
      try {
        return ok(await stackStatus(stack_id));
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "queue_status",
    {
      title: "Get merge queue status",
      description:
        "List live merge queue entries for the current user, optionally filtered by stack. This tool is read-only.",
      inputSchema: {
        stack_id: z.string().min(1).optional(),
      },
    },
    async ({ stack_id }) => {
      try {
        return ok(await queueStatus(stack_id));
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "settings_get",
    {
      title: "Get settings",
      description:
        "Read the Bearer /api/v1/settings toggles, including auto_patch_enabled and cyclone_connected. This tool is read-only.",
    },
    async () => {
      try {
        return ok(await settingsGet());
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "settings_set",
    {
      title: "Update settings",
      description:
        "Update writable Bearer /api/v1/settings toggles and return the stored result. At least one key is required. cyclone_connected and github_connected are read-only and cannot be set.",
      inputSchema: {
        auto_review_enabled: z.boolean().optional(),
        auto_patch_enabled: z.boolean().optional(),
        vortex_show_thinking_traces: z.boolean().optional(),
        repo_overview_enabled: z.boolean().optional(),
        review_unit_land_prs_enabled: z.boolean().optional(),
        cyclone_review_unit_land_prs_enabled: z.boolean().optional(),
        vortex_seam_specialist_enabled: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        return ok(await settingsSet(args ?? {}));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
