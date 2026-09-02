import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  CommandError,
  REVIEW_THREAD_SLUG_RE,
  ReviewPollTimeoutError,
  collectReviewInput,
  loadConfig,
  loadReviewContext,
  pollReview,
  rateLimitedMessage,
  submitReview,
  type Config,
  type ReviewInput,
  type ReviewJobRow,
} from "mergestorm/client";
import { payloadFromRateLimit, payloadFromRow } from "./envelope.js";
import type { ToolPayload } from "./types.js";

/** Hosts should not hang; cap each submit/wait call at five minutes. */
export const MCP_WAIT_CEILING_S = 300;

/** Pinnable L0 lanes. `governance` and `seam` are L1 and cannot be requested. */
const PINNABLE_SPECIALISTS = [
  "security",
  "performance",
  "architecture",
  "tests",
  "data",
  "api",
  "frontend",
] as const;

export function assertPinnableSpecialists(specialists: string[] | undefined): void {
  if (!specialists?.length) return;
  const unknown = specialists.filter(
    (id) => !(PINNABLE_SPECIALISTS as readonly string[]).includes(id),
  );
  if (unknown.length === 0) return;
  throw new CommandError(
    `Unknown specialist: ${unknown.join(", ")}. Valid lanes: ${PINNABLE_SPECIALISTS.join(", ")}. governance and seam cannot be requested.`,
    2,
    "usage",
  );
}

/**
 * Host-configured root that agent-chosen `context_files` may not escape.
 * The `cwd` tool argument is agent-controlled, so it cannot serve as the
 * sandbox root; default to the MCP server's own working directory.
 */
export function mcpSandboxRoot(): string {
  return process.env.MERGESTORM_SANDBOX_ROOT?.trim() || process.cwd();
}

export type ReviewSubmitInput = {
  cwd?: string;
  base?: string;
  head?: string;
  diff?: string;
  router?: string;
  specialists?: string[];
  context?: string;
  context_files?: string[];
  thread?: string;
  idempotency_key?: string;
  wait?: boolean;
  timeout_s?: number;
};

export type ReviewSubmitOptions = {
  pollIntervalMs?: number;
};

export function waitTimeoutMs(timeout_s?: number): number {
  const seconds = timeout_s ?? MCP_WAIT_CEILING_S;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CommandError("timeout_s must be a positive number of seconds", 2, "usage");
  }
  return Math.max(1, Math.round(Math.min(seconds, MCP_WAIT_CEILING_S) * 1_000));
}

async function resolveInput(input: ReviewSubmitInput): Promise<ReviewInput | null> {
  const cwd = input.cwd ?? process.cwd();
  const head = input.head?.trim() || "HEAD";
  if (input.diff?.trim()) {
    const branch = "local";
    const thread =
      input.thread?.trim() ||
      `local/diff-${createHash("sha256").update(input.diff).digest("hex").slice(0, 12)}`;
    return {
      thread,
      branch,
      baseLabel: input.base?.trim() || "main",
      headLabel: head,
      diff: input.diff,
      files: [],
    };
  }

  const bases = input.base?.trim()
    ? [input.base.trim()]
    : ["main", "master"];
  const sandboxRoot = mcpSandboxRoot();
  try {
    const [sandboxReal, cwdReal] = await Promise.all([
      realpath(resolve(sandboxRoot)),
      realpath(resolve(cwd)),
    ]);
    const relToSandbox = relative(sandboxReal, cwdReal);
    if (relToSandbox === ".." || relToSandbox.startsWith(`..${sep}`)) {
      throw new CommandError("cwd must be inside the configured sandbox root", 2, "usage");
    }
  } catch (err) {
    if (err instanceof CommandError) throw err;
    throw new CommandError("cwd must be inside the configured sandbox root", 2, "usage");
  }
  let lastErr: unknown;
  let collected: ReviewInput | null = null;
  let yielded = false;
  for (const base of bases) {
    try {
      const candidate = await collectReviewInput(base, head, cwd, sandboxRoot);
      yielded = true;
      if (!collected) collected = candidate;
    } catch (err) {
      // Once a base yielded a result (even null = no_changes), a later
      // fallback base that doesn't exist (e.g. no `master` ref) must not
      // mask it with an error.
      if (yielded) continue;
      lastErr = err;
      if (input.base?.trim()) throw err;
    }
  }
  if (yielded) return collected;
  if (lastErr) throw lastErr;
  return null;
}

export async function reviewSubmit(
  input: ReviewSubmitInput,
  cfg?: Config,
  opts: ReviewSubmitOptions = {},
): Promise<ToolPayload> {
  const resolved = cfg ?? (await loadConfig());
  const wait = input.wait !== false;
  const timeoutMs = waitTimeoutMs(input.timeout_s);
  assertPinnableSpecialists(input.specialists);

  if (input.thread && !REVIEW_THREAD_SLUG_RE.test(input.thread)) {
    throw new CommandError("thread must be 1–120 chars [A-Za-z0-9._/-]", 2, "usage");
  }
  if (input.context === "-") {
    throw new CommandError(
      'context "-" (stdin) is not available over MCP; pass the text directly',
      2,
      "usage",
    );
  }

  const collected = await resolveInput(input);
  if (!collected) {
    return payloadFromRow(null, { status: "no_changes" });
  }
  if (input.thread) collected.thread = input.thread;

  const extras = await loadReviewContext({
    context: input.context,
    contextFiles: input.context_files ?? [],
    cwd: input.cwd ?? process.cwd(),
    sandboxCwd: mcpSandboxRoot(),
  });

  const submitted = await submitReview(resolved, collected, {
    routerMode: input.router,
    specialists: input.specialists,
    context: extras.context,
    contextFiles: extras.contextFiles,
    idempotencyKey: input.idempotency_key,
  });
  const jobId = submitted.row.job_id ?? submitted.row.id ?? null;

  if (submitted.status === 402) {
    return payloadFromRow(submitted.row, {
      jobId,
      status: "quota_exceeded",
      error: "Review limit reached for this period.",
    });
  }
  if (submitted.status === 429) {
    return payloadFromRow(submitted.row, {
      jobId,
      status: "rate_limited",
      error: rateLimitedMessage(submitted.retryAfterSeconds),
      retryAfterSeconds: submitted.retryAfterSeconds,
    });
  }
  if (submitted.status !== 202 && submitted.status !== 200) {
    throw new CommandError(JSON.stringify(submitted.row));
  }
  if (!jobId) {
    throw new CommandError("Review API returned no job_id");
  }

  if (!wait) {
    return payloadFromRow(submitted.row, { jobId, status: submitted.row.status ?? "queued" });
  }

  let row: ReviewJobRow;
  try {
    row = await pollReview(resolved, jobId, {
      timeoutMs,
      intervalMs: opts.pollIntervalMs,
    });
  } catch (err) {
    if (err instanceof ReviewPollTimeoutError) {
      return payloadFromRow(err.lastRow, {
        jobId,
        status: err.lastRow.status ?? "in_progress",
        error: "Timed out waiting for review.",
      });
    }
    const rateLimited = payloadFromRateLimit(err, jobId);
    if (rateLimited) return rateLimited;
    throw err;
  }
  return payloadFromRow(row, { jobId });
}
