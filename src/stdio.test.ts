import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_TOOL_NAMES } from "./server.js";

test("stdio initialize lists stack_wait and queue_status as read-only", { timeout: 15_000 }, async (t) => {
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
      MERGESTORM_API_URL: `http://127.0.0.1:${address.port}`,
    },
  });
  const client = new Client({ name: "mergestorm-mcp-test", version: "0.0.0" });
  try {
    await client.connect(transport, { timeout: 10_000 });
    assert.match(client.getInstructions() ?? "", /mergestorm-loop: dismiss/);
    assert.match(client.getInstructions() ?? "", /smallest correct patch/);
    assert.match(client.getInstructions() ?? "", /waiting with nonempty issues\[\] is not idle/);
    assert.match(client.getInstructions() ?? "", /never merge or rebase onto mg-park-\*/);
    assert.match(client.getInstructions() ?? "", /Attention is not a mutation/);
    assert.match(client.getInstructions() ?? "", /mg-stack-<n>/);
    assert.match(client.getInstructions() ?? "", /Never retarget a stack PR's GitHub base/);
    const listed = await client.listTools(undefined, { timeout: 10_000 });
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...MCP_TOOL_NAMES].sort(),
    );
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
    assert.match(stackWait.description ?? "", /This tool is read-only/);
    assert.match(stackWait.description ?? "", /waiting or in_progress/);
    assert.match(stackWait.description ?? "", /timeout_s: 1-45/);
    assert.match(stackWait.description ?? "", /A timeout with either of those statuses is not a failure/);
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
    assert.match(queueStatus.description ?? "", /This tool is read-only/);
    assert.deepEqual(queueStatus.inputSchema.required, undefined);
    assert.equal(
      (queueStatus.inputSchema.properties?.stack_id as { type?: string } | undefined)?.type,
      "string",
    );
  } finally {
    await client.close();
  }
});
