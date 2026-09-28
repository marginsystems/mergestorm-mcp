import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CommandError, BEARER_SETTINGS } from "mergestorm/client";
import { MCP_SERVER_ICONS, MCP_WEBSITE_URL } from "./brand-icons.js";
import { credits } from "./tools/credits.js";
import { queueStatus } from "./tools/queue-status.js";
import { reviewDismiss } from "./tools/review-dismiss.js";
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
import {
  MCP_STACK_DONE_INSTRUCTIONS,
  MCP_PR_LOOP_INSTRUCTIONS,
  MCP_STACK_BASE_INSTRUCTIONS,
  MCP_STACK_WATCH_INSTRUCTIONS,
} from "./pr-loop-instructions.js";

export const MCP_SERVER_NAME = "mergestorm";
export const MCP_SERVER_VERSION = "0.2.2";

export const MCP_TOOL_NAMES = [
  "whoami",
  "credits",
  "review_list",
  "review_submit",
  "review_wait",
  "review_wait_pr",
  "review_dismiss",
  "stack_adopt",
  "stack_list",
  "stack_set",
  "stack_status",
  "stack_wait",
  "queue_status",
  "settings_get",
  "settings_set",
] as const;

export const MCP_SERVER_INSTRUCTIONS = [
  MCP_STACK_DONE_INSTRUCTIONS,
  MCP_PR_LOOP_INSTRUCTIONS,
  MCP_STACK_BASE_INSTRUCTIONS,
  MCP_STACK_WATCH_INSTRUCTIONS,
].join("\n\n");

const STACK_WATCH_RESULT_NOTE =
  " The result carries watch {done, until: \"landed\", reason, next, message}: while watch.done is false the stack is not landed and your task is not done; call stack_wait with watch.next.args.";

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
      title: "Mergestorm",
      version: MCP_SERVER_VERSION,
      websiteUrl: MCP_WEBSITE_URL,
      icons: MCP_SERVER_ICONS,
    },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  // MCP SDK + zod generic inference hits TS2589 on several schemas; keep
  // runtime registerTool, drop the instantiation from our typecheck.
  const addTool = server.registerTool.bind(server) as (
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      annotations?: ToolAnnotations;
    },
    cb: (...args: any[]) => unknown,
  ) => void;

  addTool(
    "whoami",
    {
      title: "Who am I",
      description: "Current Mergestorm API key prefix, plan, and API base.",
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: true },
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
        "Read one local Mergestorm review job by the job_id that review_submit returned, as a job envelope. timeout_s: 0 reads it once without polling; otherwise it polls for one 45s slice by default (max 300s). On timeout, returns in_progress; call again with the same job_id until done. Do not pass 300; hosts drop long MCP calls. On rate_limited, wait retry_after_seconds before trying again.",
      inputSchema: {
        job_id: z.string().min(1),
        timeout_s: z.number().min(0).max(300).optional(),
      },
      annotations: { readOnlyHint: true },
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
        "Read the Vortex pass on a GitHub PR from the DB-only endpoint; review identity is head SHA + pass. timeout_s: 0 reads it once without polling; otherwise it polls for one 45s slice by default (max 300) and returns in_progress on timeout so you can call again. Pass after_sha for the head you pushed and pass to read one exact attempt; when you already hold a resting envelope for that head, also pass after_pass set to its pass and keep it unchanged across retries; never replace it with the pass of an in-progress envelope, and omit after_pass for a head you hold no envelope for. With timeout_s: 0, a pass that does not exist yet returns not_found, so after a push use a positive timeout. Do not pass 300; hosts drop long MCP calls. On rate_limited, wait retry_after_seconds before trying again. After a resting pass, verify each finding; prefer the smallest correct patch; if you skip, post a PR comment starting with mergestorm-loop: dismiss.",
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pr_number: z.number().int().min(1),
        after_sha: z.string().optional(),
        pass: z.number().int().min(1).optional(),
        after_pass: z.number().int().min(1).optional(),
        timeout_s: z.number().min(0).max(300).optional(),
      },
      annotations: { readOnlyHint: true },
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
    "review_dismiss",
    {
      title: "Dismiss Vortex findings",
      description:
        "Record an audited dismissal of Vortex findings you verified are wrong or not actionable on a GitHub PR. Identity is exact: head_sha must be the PR's live head, review_id a Vortex review (Core or seam) made at that head, and finding_ids the GitHub review comment ids of that review (offdiff-<n> for a body-only finding), or scope \"review\" with no finding_ids to dismiss every finding of that review. reason must say why (at least 20 characters); evidence_url is optional. Call with preview: true first to list the review's finding ids and the seam gate without writing. The caller's linked GitHub account needs write access to the repository. A moved head, another review, an unknown id or a missing permission is refused and nothing is written. Retries are idempotent. The seam gate clears only when every finding of that integration review is dismissed; CI, other reviews and Auto land policy are unchanged. Vortex does not raise a dismissed finding again on the same diff. Never dismiss a finding you did not check." + STACK_WATCH_RESULT_NOTE,
      inputSchema: {
        owner: z.string().min(1),
        repo: z.string().min(1),
        pr_number: z.number().int().min(1),
        head_sha: z.string().regex(/^[0-9a-fA-F]{40}$/),
        review_id: z.number().int().min(1),
        finding_ids: z.array(z.string().min(1)).max(50).optional(),
        scope: z.enum(["findings", "review"]).optional(),
        reason: z.string().optional(),
        evidence_url: z.string().url().optional(),
        preview: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        return ok(await reviewDismiss(args));
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
        "Adopt an open GitHub PR chain into a Mergestorm stack. auto_land is boolean; auto_review and auto_patch accept true, false, or null, where null clears the override. Omitted auto_land seeds from auto_land_default; omitted auto_review and auto_patch overrides are not seeded. Never changes account settings. Adoption requires a Cyclone GitHub App install; without it the API returns cyclone_not_connected — do not retry, tell the human. Read stack_status with result.stack.id afterward to verify policy and Cyclone ownership. With 2+ PRs, adopt moves the bottom PR's GitHub base to mg-stack-<n> and parks PR3+ on an mg-park-* freeze; a 1-PR stack stays on main. Leave those bases. Never retarget the bottom back to main." + STACK_WATCH_RESULT_NOTE,
      inputSchema: stackAdoptSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
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
        "List the current user's Mergestorm stacks.",
      annotations: { readOnlyHint: true },
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
        "Set per-stack automation on one owned Mergestorm stack: auto_land arms or disarms Auto land; auto_review and auto_patch pin Vortex auto-review or Cyclone auto-patch for this stack only (true or false), and null clears the pin so the stack follows the account setting again. Pass at least one key. Never changes account settings." + STACK_WATCH_RESULT_NOTE,
      inputSchema: {
        stack_id: z.string().min(1),
        auto_land: z.boolean().optional(),
        auto_review: z.boolean().nullable().optional(),
        auto_patch: z.boolean().nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
        "Fetch one owned Mergestorm stack with enriched checks and agent state, plus attention, issues, and currentCandidate from the same blocker rules as stack_wait, read against that stack's own merge queue. trunkBranch is mg-stack-<n> for an adopted 2+ PR stack and matches the bottom open PR's GitHub base; an mg-park-* parentBranch is a freeze. Neither is drift to fix. repair names the concrete fix for attention; landGatePending is a wait, not attention. held names a blocker no agent run clears while Vortex or Cyclone is still busy on that PR (actAfter agents_idle, waitingOn); repair then describes the fix to plan, not to apply yet." + STACK_WATCH_RESULT_NOTE,
      inputSchema: {
        stack_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
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
        "Wait for a stack to need attention. Returns a mergestorm.stack_watch/v1 envelope; timeout_s: 0 returns one snapshot and timeout_s: 1-45 waits up to that many seconds, returning the current status (waiting or in_progress) if a snapshot was read and no attention is found. A timeout with either of those statuses is not a failure; waiting and in_progress end this slice, and the next call is stack_wait again with the same cursor. A timeout of failed means no assessment was produced. A stack that no longer exists returns status failed with watch.done true (reason not_found) and is not an error. While Cyclone or Vortex is still working on the blocked PR it returns in_progress, not attention, with busy[] naming the PR, blocker, and agent; agents carries that PR's vortexStatus, cycloneStatus, vortexReview, and busy flags. A blocker no agent run clears (a merge conflict vs the live parent, a restack Conflict or Restack failed, a Draft PR) is still named during that in_progress, in blocker, prNumber, headSha, and issues[], with actAfter: \"agents_idle\" and waitingOn listing the busy agents: plan the fix, and act when a snapshot after the agents finish returns attention, re-reading the blocker then. Blockers the agents can change keep blocker and actAfter null. Attention never calls for changing a PR's GitHub base. When present, repair names the concrete fix for attention (restack_conflict and merge_conflict carry liveParent, never mg-park-*). A pending land gate (landGatePending) returns in_progress, not attention." + STACK_WATCH_RESULT_NOTE,
      inputSchema: stackWaitSchema,
      annotations: { readOnlyHint: true },
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
        "List live merge queue entries (position >= 1) plus the newest bounced entries (position 0) with bounceDetail for the current user, optionally filtered by stack.",
      inputSchema: {
        stack_id: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
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
        "Read the Bearer /api/v1/settings toggles, including auto_patch_enabled, auto_land_settle_seconds (how long Auto land waits before queueing), and cyclone_connected.",
      annotations: { readOnlyHint: true },
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
        "Update writable Bearer /api/v1/settings values and return the stored result. At least one key is required. auto_land_settle_seconds is a whole number of seconds from 15 through 300; it applies to settle clocks that start after the write. cyclone_connected and github_connected are read-only and cannot be set.",
      inputSchema: {
        ...Object.fromEntries(
          BEARER_SETTINGS.map((row) => [row.key,
            ("kind" in row
              ? row.kind === "logins"
                ? z.array(z.string())
                : row.kind === "seconds"
                  ? z.number().int().min(row.min).max(row.max)
                  : z.enum(row.values)
              : z.boolean()).optional(),
          ]),
        ),
        // Preserve these args so the handler rejects them even alongside a writable key.
        cyclone_connected: z.unknown().optional(),
        github_connected: z.unknown().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
