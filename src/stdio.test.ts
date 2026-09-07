import assert from "node:assert/strict";
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

test("stdio initialize lists queue_status as read-only with an optional filter", { timeout: 15_000 }, async () => {
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
      MERGESTORM_API_URL: "https://api.example.test",
    },
  });
  const client = new Client({ name: "mergestorm-mcp-test", version: "0.0.0" });
  try {
    await client.connect(transport, { timeout: 10_000 });
    assert.match(client.getInstructions() ?? "", /mergestorm-loop: dismiss/);
    assert.match(client.getInstructions() ?? "", /smallest correct patch/);
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
