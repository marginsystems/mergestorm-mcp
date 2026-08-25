import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { CommandError, REVIEW_JOB_ENVELOPE_SCHEMA } from "mergestorm/client";
import { reviewSubmit } from "./review-submit.js";
import { reviewWait } from "./review-wait.js";

const cfg = {
  apiKey: "msk_live_test_mcp_write",
  apiBase: "https://api.example.test",
};

let originalFetch: typeof globalThis.fetch | undefined;

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
});

async function repoWithReviewDiff(prefix: string): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "fixture\nchanged\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });
  return { root, repo };
}

function mockReviewFetch(
  responses: { status: number; body: unknown; headers?: Record<string, string> }[],
): { calls: () => number; posts: () => unknown[] } {
  originalFetch = globalThis.fetch;
  let n = 0;
  const posts: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && init?.body) {
      posts.push(JSON.parse(String(init.body)));
    }
    const r = responses[Math.min(n, responses.length - 1)]!;
    n += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json", ...r.headers },
    });
  };
  return { calls: () => n, posts: () => posts };
}

describe("review write tools", { concurrency: false }, () => {
  test("review_submit without wait posts the same payload as collectReviewInput", async () => {
    const f = await repoWithReviewDiff("mcp-submit-");
    process.env.MERGESTORM_SANDBOX_ROOT = f.root;
    try {
      const mock = mockReviewFetch([
        { status: 202, body: { job_id: "job_s", status: "queued", thread_slug: "local/main" } },
      ]);
      const result = await reviewSubmit(
        { cwd: f.repo, base: "main", wait: false, context: "focus on auth" },
        cfg,
      );
      assert.equal(result.data.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
      assert.equal(result.data.job_id, "job_s");
      assert.equal(result.data.status, "queued");
      assert.equal(mock.calls(), 1);
      const posted = mock.posts()[0] as {
        base_label: string;
        head_label: string;
        diff: string;
        files: { path: string }[];
        context: string;
        thread: string;
      };
      assert.equal(posted.base_label, "main");
      assert.equal(posted.head_label, "HEAD");
      assert.match(posted.diff, /changed/);
      assert.equal(posted.files[0]?.path, "README.md");
      assert.equal(posted.context, "focus on auth");
      assert.match(posted.thread, /^local\//);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      delete process.env.MERGESTORM_SANDBOX_ROOT;
    }
  });

  test("review_submit auto-collect drops tracked files outside the sandbox root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-sandbox-"));
    const repo = path.join(root, "repo");
    const sandbox = path.join(repo, "pkg");
    await mkdir(repo);
    await mkdir(sandbox);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "fixture\n");
    await writeFile(path.join(sandbox, "code.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "fixture\nsecret\n");
    await writeFile(path.join(sandbox, "code.ts"), "export const x = 2;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });

    process.env.MERGESTORM_SANDBOX_ROOT = sandbox;
    try {
      const mock = mockReviewFetch([
        { status: 202, body: { job_id: "job_sb", status: "queued", thread_slug: "local/main" } },
      ]);
      const result = await reviewSubmit({ cwd: sandbox, base: "main", wait: false }, cfg);
      assert.equal(result.data.job_id, "job_sb");
      const posted = mock.posts()[0] as { files: { path: string }[]; diff: string };
      assert.deepEqual(
        posted.files.map((f) => f.path),
        ["pkg/code.ts"],
      );
      assert.match(posted.diff, /export const x = 2/);
      assert.doesNotMatch(posted.diff, /secret/);
    } finally {
      await rm(root, { recursive: true, force: true });
      delete process.env.MERGESTORM_SANDBOX_ROOT;
    }
  });

  test("review_submit reviews a deletion-only branch instead of reporting no_changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-delete-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(path.join(repo, "auth.ts"), "export const check = true;\n");
    await writeFile(path.join(repo, "keep.ts"), "export const keep = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
    execFileSync("git", ["rm", "-q", "auth.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "remove auth check"], { cwd: repo });

    process.env.MERGESTORM_SANDBOX_ROOT = root;
    try {
      const mock = mockReviewFetch([
        { status: 202, body: { job_id: "job_del", status: "queued", thread_slug: "local/main" } },
      ]);
      const result = await reviewSubmit({ cwd: repo, base: "main", wait: false }, cfg);
      assert.equal(result.data.job_id, "job_del");
      const posted = mock.posts()[0] as { diff: string; files: { path: string }[] };
      assert.match(posted.diff, /auth\.ts/);
      assert.match(posted.diff, /deleted file mode/);
      assert.ok(
        !posted.files.some((f) => f.path === "auth.ts"),
        "deleted file must not be uploaded for contents",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      delete process.env.MERGESTORM_SANDBOX_ROOT;
    }
  });

  test("review_submit on a clean master-only tree returns no_changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-master-clean-"));
    const repo = path.join(root, "repo");
    await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });

    process.env.MERGESTORM_SANDBOX_ROOT = root;
    try {
      const mock = mockReviewFetch([
        { status: 202, body: { job_id: "job_should_not_post", status: "queued" } },
      ]);
      const result = await reviewSubmit({ cwd: repo, wait: false }, cfg);
      assert.equal(result.data.status, "no_changes");
      assert.equal(mock.calls(), 0);
    } finally {
      await rm(root, { recursive: true, force: true });
      delete process.env.MERGESTORM_SANDBOX_ROOT;
    }
  });

  test("review_submit surfaces a governance 400 verbatim", async () => {
    const f = await repoWithReviewDiff("mcp-gov-");
    process.env.MERGESTORM_SANDBOX_ROOT = f.root;
    try {
      mockReviewFetch([
        { status: 400, body: { error: "invalid_specialists" } },
      ]);
      await assert.rejects(
        () =>
          reviewSubmit(
            {
              cwd: f.repo,
              base: "main",
              wait: false,
              specialists: ["governance"],
            },
            cfg,
          ),
        (err: unknown) =>
          err instanceof CommandError && /invalid_specialists/.test(err.message),
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
      delete process.env.MERGESTORM_SANDBOX_ROOT;
    }
  });

  test("review_submit returns a structured rate_limited envelope on 429", async () => {
    const f = await repoWithReviewDiff("mcp-rate-limit-");
    process.env.MERGESTORM_SANDBOX_ROOT = f.root;
    try {
      mockReviewFetch([
        {
          status: 429,
          body: {
            error: "too_many_in_flight_jobs",
            retry_after_seconds: 30,
          },
          headers: { "Retry-After": "30" },
        },
      ]);
      const result = await reviewSubmit(
        { cwd: f.repo, base: "main", wait: false },
        cfg,
      );
      assert.equal(result.data.status, "rate_limited");
      assert.equal(result.data.retry_after_seconds, 30);
      assert.match(String(result.data.error), /Wait for a running review/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      delete process.env.MERGESTORM_SANDBOX_ROOT;
    }
  });

  test("review_submit wait timeout returns in_progress and the job id", async () => {
    const f = await repoWithReviewDiff("mcp-timeout-");
    process.env.MERGESTORM_SANDBOX_ROOT = f.root;
    try {
      mockReviewFetch([
        { status: 202, body: { job_id: "job_slow", status: "queued" } },
        { status: 200, body: { job_id: "job_slow", status: "in_progress" } },
      ]);
      const result = await reviewSubmit(
        { cwd: f.repo, base: "main", wait: true, timeout_s: 0.05 },
        cfg,
        { pollIntervalMs: 1 },
      );
      assert.equal(result.data.job_id, "job_slow");
      assert.equal(result.data.status, "in_progress");
      assert.match(String(result.data.error), /Timed out/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      delete process.env.MERGESTORM_SANDBOX_ROOT;
    }
  });

  test("review_wait polls until completed", async () => {
    mockReviewFetch([
      { status: 200, body: { job_id: "job_w", status: "queued" } },
      { status: 200, body: { job_id: "job_w", status: "completed", verdict: "approve" } },
    ]);
    const result = await reviewWait("job_w", 2, cfg, { pollIntervalMs: 1 });
    assert.equal(result.data.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
    assert.equal(result.data.job_id, "job_w");
    assert.equal(result.data.status, "completed");
    assert.equal(result.data.verdict, "approve");
  });

  test("review_wait timeout returns in_progress", async () => {
    mockReviewFetch([
      { status: 200, body: { job_id: "job_hang", status: "in_progress" } },
    ]);
    const result = await reviewWait("job_hang", 0.05, cfg, { pollIntervalMs: 1 });
    assert.equal(result.data.job_id, "job_hang");
    assert.equal(result.data.status, "in_progress");
  });

  test("review_wait returns rate_limited after poll retries", async () => {
    mockReviewFetch([
      {
        status: 429,
        body: { error: "rate_limited", retry_after_seconds: 0 },
        headers: { "Retry-After": "0" },
      },
    ]);
    const result = await reviewWait("job_limited", 60, cfg, { pollIntervalMs: 1 });
    assert.equal(result.data.job_id, "job_limited");
    assert.equal(result.data.status, "rate_limited");
    assert.equal(result.data.retry_after_seconds, 0);
  });
});
