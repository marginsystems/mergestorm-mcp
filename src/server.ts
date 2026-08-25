import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CommandError } from "mergestorm/client";
import { credits } from "./tools/credits.js";
import { reviewGet } from "./tools/review-get.js";
import { reviewList } from "./tools/review-list.js";
import { reviewSubmit } from "./tools/review-submit.js";
import { reviewWait } from "./tools/review-wait.js";
import type { ToolPayload } from "./tools/types.js";
import { whoami } from "./tools/whoami.js";

export const MCP_SERVER_NAME = "mergestorm";
export const MCP_SERVER_VERSION = "0.1.0";

export const MCP_TOOL_NAMES = [
  "whoami",
  "credits",
  "review_list",
  "review_get",
  "review_submit",
  "review_wait",
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
    "review_submit",
    {
      title: "Submit review",
      description:
        "Submit a local git diff (or an explicit diff) as a Mergestorm review job. Default waits up to 300s. On rate_limited, wait retry_after_seconds and inspect or wait for an in-flight review before resubmitting.",
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

  return server;
}
