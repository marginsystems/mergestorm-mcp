import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_SERVER_ICONS } from "./brand-icons.js";
import { MCP_TOOL_NAMES } from "./server.js";

function structuredData(result: Record<string, unknown>): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

async function connectStdioClient(apiUrl: string): Promise<Client> {
  const tsxCli = path.join(
    path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
    "dist/cli.mjs",
  );
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, entry],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...getDefaultEnvironment(),
      MERGESTORM_API_KEY: "msk_test_stdio_smoke",
      MERGESTORM_API_URL: apiUrl,
    },
  });
  const client = new Client({ name: "mergestorm-mcp-test", version: "0.0.0" });
  await client.connect(transport, { timeout: 10_000 });
  return client;
}

test("stdio initialize lists tools with read-only and write annotations", { timeout: 15_000 }, async (t) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    assert.equal(request.method, "GET");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url!.includes("/queue") ? { entries: [] } : { stacks: [{ id: "stack-1", layers: [] }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = await connectStdioClient(`http://127.0.0.1:${address.port}`);
  try {
    const serverInfo = client.getServerVersion();
    assert.equal(serverInfo?.title, "Mergestorm");
    assert.deepEqual(serverInfo?.icons, MCP_SERVER_ICONS);
    assert.match(client.getInstructions() ?? "", /mergestorm-loop: dismiss/);
    assert.match(client.getInstructions() ?? "", /smallest correct patch/);
    assert.match(client.getInstructions() ?? "", /waiting with nonempty issues\[\] is not idle/);
    assert.match(client.getInstructions() ?? "", /never merge or rebase onto mg-park-\*/);
    assert.match(client.getInstructions() ?? "", /Attention is not a mutation/);
    assert.match(client.getInstructions() ?? "", /mg-stack-<n>/);
    assert.match(client.getInstructions() ?? "", /Never retarget a stack PR's GitHub base/);
    assert.match(client.getInstructions() ?? "", /Do not patch a bounced PR while Cyclone or Vortex is still working on it/);
    assert.match(client.getInstructions() ?? "", /in_progress with a nonempty busy\[\] means wait/);
    assert.match(client.getInstructions() ?? "", /autoEnqueueSettle/);
    const listed = await client.listTools(undefined, { timeout: 10_000 });
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...MCP_TOOL_NAMES].sort(),
    );
    assert.equal(listed.tools.length, 15);
    const annotations = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool.annotations]));
    for (const name of [
      "whoami", "credits", "review_list", "review_wait", "review_wait_pr", "stack_list",
      "stack_status", "stack_wait", "queue_status", "settings_get",
    ]) {
      assert.deepEqual(annotations[name], { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, name);
    }
    assert.deepEqual(annotations.review_submit, {
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    });
    assert.deepEqual(annotations.stack_adopt, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    for (const name of ["stack_set", "review_dismiss"]) {
      assert.deepEqual(annotations[name], { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }, name);
    }
    assert.deepEqual(annotations.settings_set, {
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    });
    for (const tool of listed.tools) {
      assert.doesNotMatch(tool.description ?? "", /This tool is read-only/, tool.name);
    }
    const reviewWait = listed.tools.find((tool) => tool.name === "review_wait");
    assert.match(reviewWait?.description ?? "", /^Read one local Mergestorm review job by the job_id/);
    assert.equal((reviewWait?.inputSchema.properties?.timeout_s as { minimum?: number }).minimum, 0);
    const reviewWaitPr = listed.tools.find((tool) => tool.name === "review_wait_pr");
    assert.match(reviewWaitPr?.description ?? "", /^Read the Vortex pass on a GitHub PR/);
    assert.match(reviewWaitPr?.description ?? "", /never replace it with the pass of an in-progress envelope, and omit after_pass for a head you hold no envelope for/);
    assert.match(reviewWaitPr?.description ?? "", /With timeout_s: 0, a pass that does not exist yet returns not_found, so after a push use a positive timeout/);
    assert.equal((reviewWaitPr?.inputSchema.properties?.timeout_s as { minimum?: number }).minimum, 0);
    const stackAdopt = listed.tools.find((tool) => tool.name === "stack_adopt");
    assert.ok(stackAdopt);
    assert.deepEqual(stackAdopt.inputSchema.required, ["owner", "repo", "pr_number"]);
    assert.deepEqual(
      Object.keys(stackAdopt.inputSchema.properties ?? {}).sort(),
      ["auto_land", "auto_patch", "auto_review", "owner", "pr_number", "repo"],
    );
    const stackSet = listed.tools.find((tool) => tool.name === "stack_set");
    assert.ok(stackSet);
    // Only the id is required: any subset of auto_land / auto_review /
    // auto_patch is valid, and the handler rejects an empty subset.
    assert.deepEqual(stackSet.inputSchema.required, ["stack_id"]);
    assert.deepEqual(
      Object.keys(stackSet.inputSchema.properties ?? {}).sort(),
      ["auto_land", "auto_patch", "auto_review", "stack_id"],
    );
    const stackWait = listed.tools.find((tool) => tool.name === "stack_wait");
    assert.ok(stackWait);
    assert.match(stackWait.description ?? "", /returns in_progress, not attention, with busy\[\] naming the PR, blocker, and agent; agents carries that PR's vortexStatus, cycloneStatus, vortexReview, and busy flags/);
    assert.match(stackWait.description ?? "", /waiting or in_progress/);
    assert.match(stackWait.description ?? "", /timeout_s: 1-45/);
    assert.match(stackWait.description ?? "", /A timeout with either of those statuses is not a failure/);
    assert.match(stackWait.description ?? "", /waiting and in_progress end this slice, and the next call is stack_wait again with the same cursor/);
    assert.match(stackWait.description ?? "", /A timeout of failed means no assessment was produced/);
    assert.deepEqual(stackWait.inputSchema.required, ["stack_id"]);
    assert.deepEqual(Object.keys(stackWait.inputSchema.properties ?? {}).sort(),
      ["after_finished_at", "bounce_id", "enrolled_head_sha", "stack_id", "timeout_s"]);
    const timeout = stackWait.inputSchema.properties?.timeout_s as { default: number; maximum: number };
    assert.equal(timeout.default, 45);
    assert.equal(timeout.maximum, 45);
    const result = await client.callTool({ name: "stack_wait", arguments: {
      stack_id: "stack-1", timeout_s: 0, enrolled_head_sha: null, after_finished_at: null,
    } });
    assert.notEqual(result.isError, true);
    const data = result.structuredContent as Record<string, unknown>;
    assert.equal(data.schema, "mergestorm.stack_watch/v1");
    assert.equal(data.status, "waiting");
    assert.deepEqual(data.busy, []);
    assert.equal(data.assessment, "available");
    assert.deepEqual(data.issues, []);
    assert.deepEqual(requests, ["/api/v1/stacks/enrich?stackId=stack-1", "/api/v1/stacks/queue?stackId=stack-1"]);
    assert.deepEqual(data.cursor, {
      stackId: "stack-1", enrolledHeadSha: null, afterFinishedAt: null,
    });
    const invalid = await client.callTool({ name: "stack_wait", arguments: { stack_id: "stack-1", timeout_s: 301 } });
    assert.equal(invalid.isError, true);
    const queueStatus = listed.tools.find((tool) => tool.name === "queue_status");
    assert.ok(queueStatus);
    assert.deepEqual(queueStatus.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    assert.deepEqual(queueStatus.inputSchema.required, undefined);
    assert.equal(
      (queueStatus.inputSchema.properties?.stack_id as { type?: string } | undefined)?.type,
      "string",
    );
  } finally {
    await client.close();
  }
});

test("stdio results preserve nulls and errors for structured and text-only clients", { timeout: 15_000 }, async (t) => {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push({ method: request.method!, url: request.url!, body: text ? JSON.parse(text) : null });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/v1/me") {
      response.end(JSON.stringify({ key: { prefix: "msk_test", name: null }, plan_key: null, plan_label_key: null, usage: null }));
    } else if (request.url === "/api/v1/stacks/stack-1") {
      response.end(JSON.stringify({ autoReviewOverride: null, autoPatchOverride: null }));
    } else if (request.url === "/api/v1/settings") {
      response.writeHead(429, { "Retry-After": "9" });
      response.end(JSON.stringify({ error: "rate_limited", retry_after_seconds: 9 }));
    } else {
      response.writeHead(500);
      response.end(JSON.stringify({ error: "unexpected_test_route" }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = await connectStdioClient(`http://127.0.0.1:${address.port}`);
  try {
    const identity = await client.callTool({ name: "whoami", arguments: {} });
    assert.notEqual(identity.isError, true);
    const data = structuredData(identity);
    for (const key of ["key_name", "plan_key", "plan_label_key", "usage"]) assert.equal(data[key], null, key);

    const cleared = await client.callTool({ name: "stack_set", arguments: {
      stack_id: "stack-1", auto_review: null, auto_patch: null,
    } });
    assert.notEqual(cleared.isError, true);
    assert.equal(structuredData(cleared).auto_review, null);
    assert.equal(structuredData(cleared).auto_patch, null);
    assert.deepEqual(structuredData(cleared).result, { autoReviewOverride: null, autoPatchOverride: null });

    const invalid = await client.callTool({ name: "stack_set", arguments: { stack_id: "stack-1" } });
    assert.equal(invalid.isError, true);
    assert.equal((structuredData(invalid).error as { code: string }).code, "invalid_input");
    const usage = await client.callTool({ name: "settings_set", arguments: {} });
    assert.equal(usage.isError, true);
    assert.equal((structuredData(usage).error as { code: string; exit_code: number }).code, "usage");
    assert.equal((structuredData(usage).error as { exit_code: number }).exit_code, 2);

    const limited = await client.callTool({ name: "settings_set", arguments: { auto_review_enabled: false } });
    assert.equal(limited.isError, true);
    assert.deepEqual(structuredData(limited).error, {
      code: "rate_limited",
      message: "Rate limited. Wait for a running review or mergestorm jobs. Retry after 9s.",
      exit_code: 7,
      retry_after_seconds: 9,
    });
    for (const result of [identity, cleared, invalid, usage, limited]) {
      const content = result.content as Array<{ type: string; text: string }>;
      assert.equal(content.length, 2);
      assert.equal(content[0]!.type, "text");
      assert.deepEqual(JSON.parse(content[1]!.text), result.structuredContent);
    }
    assert.deepEqual(requests, [
      { method: "GET", url: "/api/v1/me", body: null },
      { method: "PATCH", url: "/api/v1/stacks/stack-1", body: { autoReviewOverride: null, autoPatchOverride: null } },
      { method: "PATCH", url: "/api/v1/settings", body: { auto_review_enabled: false } },
    ]);
  } finally {
    await client.close();
  }
});

test("stdio cancellation aborts an active stack wait and resumes with its saved cursor", { timeout: 15_000 }, async (t) => {
  const requests: string[] = [];
  let observeWait!: () => void;
  const waiting = new Promise<void>(resolve => { observeWait = resolve; });
  let observeAbort!: () => void;
  const aborted = new Promise<void>(resolve => { observeAbort = resolve; });
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    requests.push(request.url!);
    if (request.url!.includes("&wait=")) {
      response.on("close", observeAbort);
      observeWait();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url!.includes("/queue")
      ? { entries: [], fingerprint: "queue-1" }
      : { stacks: [{ id: "stack-1", layers: [] }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = await connectStdioClient(`http://127.0.0.1:${address.port}`);
  try {
    const snapshot = await client.callTool({ name: "stack_wait", arguments: {
      stack_id: "stack-1", timeout_s: 0, enrolled_head_sha: null, after_finished_at: null, bounce_id: null,
    } });
    const saved = structuredData(snapshot);
    const next = (saved.watch as { next: { args: Record<string, unknown> } }).next.args;
    assert.deepEqual(saved.cursor, {
      stackId: "stack-1", enrolledHeadSha: null, afterFinishedAt: null, bounceId: null,
    });
    const controller = new AbortController();
    const pending = client.callTool({ name: "stack_wait", arguments: { ...next, timeout_s: 45 } }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof McpError);
      assert.equal(err.code, ErrorCode.RequestTimeout);
      assert.match(err.message, /AbortError/);
      return true;
    });
    await waiting;
    controller.abort();
    await rejected;
    await aborted;

    const resumed = await client.callTool({ name: "stack_wait", arguments: { ...next, timeout_s: 0 } });
    assert.notEqual(resumed.isError, true);
    assert.equal(structuredData(resumed).status, "waiting");
    assert.deepEqual(structuredData(resumed).cursor, saved.cursor);
    const content = resumed.content as Array<{ type: string; text: string }>;
    assert.deepEqual(JSON.parse(content[1]!.text), resumed.structuredContent);
    assert.equal((structuredData(resumed).watch as { done: boolean }).done, false);
    assert.deepEqual(requests.slice(-2), [
      "/api/v1/stacks/enrich?stackId=stack-1", "/api/v1/stacks/queue?stackId=stack-1",
    ]);
    assert.equal(requests.filter(url => url.includes("&wait=")).length, 1);
  } finally {
    await client.close();
  }
});
