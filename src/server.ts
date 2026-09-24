import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CommandError, BEARER_SETTINGS } from "mergestorm/client";
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
import { stackAdopt, stackAdoptSchema } from "./tools/stack-adopt.js";
import { stackList } from "./tools/stack-list.js";
import { stackSet } from "./tools/stack-set.js";
import { stackWait, stackWaitSchema } from "./tools/stack-wait.js";
import { stackStatus } from "./tools/stack-status.js";
import type { ToolPayload } from "./tools/types.js";
import { whoami } from "./tools/whoami.js";
import { MCP_PR_LOOP_INSTRUCTIONS, MCP_STACK_WATCH_INSTRUCTIONS } from "./pr-loop-instructions.js";

export const MCP_SERVER_NAME = "mergestorm";
export const MCP_SERVER_VERSION = "0.1.8";

export const MCP_TOOL_NAMES = [
  "whoami",
  "credits",
  "review_list",
  "review_get",
  "review_get_pr",
  "review_submit",
  "review_wait",
  "review_wait_pr",
  "stack_adopt",
  "stack_list",
  "stack_set",
  "stack_status",
  "stack_wait",
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
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    { instructions: `${MCP_PR_LOOP_INSTRUCTIONS}\n\n${MCP_STACK_WATCH_INSTRUCTIONS}` },
  );
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
        "Fetch the latest GitHub PR Vortex pass from the DB-only endpoint. Review identity is SHA + pass: the envelope carries pass (1 for the first review on a head; a re-review on the same head is the next pass). Pass after_sha to scope to a head, pass to read one exact attempt, or after_pass to read only a later attempt on that head. This tool is read-only. On rate_limited, wait retry_after_seconds before trying again. Verify each finding against the current code; prefer the smallest correct patch; a chat-only skip is not a dismiss (post a PR comment starting with mergestorm-loop: dismiss).",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pr_number: z.number().int().min(1),
        after_sha: z.string().optional(),
        pass: z.number().int().min(1).optional(),
        after_pass: z.number().int().min(1).optional(),
      },
    },
    async ({ owner, repo, pr_number, after_sha, pass, after_pass }) => {
      try {
        return ok(
          await reviewGetPr(owner, repo, pr_number, undefined, {
            afterSha: after_sha,
            pass,
            afterPass: after_pass,
          }),
        );
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
        "Submit a local git diff (or an explicit diff) as a Mergestorm review job. Does not wait by default; returns job_id immediately after submission. Explicit wait: true polls one 45s slice by default. Record job_id and loop review_wait until done. Do not pass 300; hosts drop long MCP calls. On rate_limited, wait retry_after_seconds and inspect or wait for an in-flight review before resubmitting. specialists may be security, performance, architecture, tests, data, api, frontend. governance and seam cannot be requested.",
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
        "Poll one Mergestorm review job for one 45s slice by default (max 300s). On timeout, returns in_progress; call again with the same job_id until done. Do not pass 300; hosts drop long MCP calls. On rate_limited, wait retry_after_seconds before trying again.",
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
        "Poll the DB-only GitHub PR Vortex pass for up to 45s (pass timeout_s to override, max 300). Review identity is SHA + pass. Pass after_sha for the head you pushed. When you already hold an envelope for that same head, also pass after_pass set to its pass so the wait cannot return that attempt again; keep after_pass unchanged across timeout retries and never replace it with the pass of an in-progress envelope. Omit after_pass for a head you have no envelope for (its first pass is 1). This tool is read-only. On timeout, returns in_progress so you can call again. Do not pass 300; hosts drop long MCP calls. On rate_limited, wait retry_after_seconds before trying again. After a resting pass, verify each finding; prefer the smallest correct patch; if you skip, post a PR comment starting with mergestorm-loop: dismiss.",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pr_number: z.number().int().min(1),
        after_sha: z.string().optional(),
        pass: z.number().int().min(1).optional(),
        after_pass: z.number().int().min(1).optional(),
        timeout_s: z.number().positive().max(300).optional(),
      },
    },
    async ({ owner, repo, pr_number, after_sha, pass, after_pass, timeout_s }) => {
      try {
        return ok(
          await reviewWaitPr(
            owner,
            repo,
            pr_number,
            after_sha,
            timeout_s,
            undefined,
            { pass, afterPass: after_pass },
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  addTool(
    "stack_adopt",
    {
      title: "Adopt PR stack",
      description:
        "Adopt an open GitHub PR chain into a Mergestorm stack. auto_land is boolean; auto_review and auto_patch accept true, false, or null, where null clears the override. Omitted auto_land seeds from auto_land_default; omitted auto_review and auto_patch overrides are not seeded. Never changes account settings. Adoption requires a Cyclone GitHub App install; without it the API returns cyclone_not_connected — do not retry, tell the human. Read stack_status with result.stack.id afterward to verify policy and Cyclone ownership.",
      inputSchema: stackAdoptSchema,
    },
    async (args) => {
      try {
        return ok(await stackAdopt(args));
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
    "stack_set",
    {
      title: "Set stack policy",
      description:
        "Set per-stack automation on one owned Mergestorm stack: auto_land arms or disarms Auto land; auto_review and auto_patch pin Vortex auto-review or Cyclone auto-patch for this stack only (true or false), and null clears the pin so the stack follows the account setting again. Pass at least one key. Never changes account settings.",
      inputSchema: {
        stack_id: z.string().min(1),
        auto_land: z.boolean().optional(),
        auto_review: z.boolean().nullable().optional(),
        auto_patch: z.boolean().nullable().optional(),
      },
    },
    async ({ stack_id, auto_land, auto_review, auto_patch }) => {
      try {
        return ok(
          await stackSet(stack_id, {
            ...(auto_land !== undefined ? { auto_land } : {}),
            ...(auto_review !== undefined ? { auto_review } : {}),
            ...(auto_patch !== undefined ? { auto_patch } : {}),
          }),
        );
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
        "Fetch one owned Mergestorm stack with enriched checks and agent state, plus attention, issues, and currentCandidate from the same blocker rules as stack_wait, read against that stack's own merge queue. This tool is read-only.",
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
    "stack_wait",
    {
      title: "Wait for stack attention",
      description:
        "Wait for a stack to need attention. Returns a mergestorm.stack_watch/v1 envelope; timeout_s: 0 returns one snapshot and timeout_s: 1-45 waits up to that many seconds, returning the current status (waiting or in_progress) if a snapshot was read and no attention is found. A timeout with either of those statuses is not a failure. A timeout of failed means no assessment was produced. This tool is read-only.",
      inputSchema: stackWaitSchema,
    },
    async (args, extra) => {
      try {
        const payload = await stackWait(args, undefined, { signal: extra.signal });
        // Preserve the versioned envelope, including nullable cursor fields.
        return { ...ok(payload), structuredContent: payload.data };
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
        "List live merge queue entries (position >= 1) plus the newest bounced entries (position 0) with bounceDetail for the current user, optionally filtered by stack. This tool is read-only.",
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
        "Update writable Bearer /api/v1/settings values and return the stored result. At least one key is required. cyclone_connected and github_connected are read-only and cannot be set.",
      inputSchema: {
        ...Object.fromEntries(
          BEARER_SETTINGS.map((row) => [row.key,
            ("kind" in row
              ? row.kind === "logins" ? z.array(z.string()) : z.enum(row.values)
              : z.boolean()).optional(),
          ]),
        ),
        // Preserve these args so the handler rejects them even alongside a writable key.
        cyclone_connected: z.unknown().optional(),
        github_connected: z.unknown().optional(),
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
