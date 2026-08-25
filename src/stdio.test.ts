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

test("stdio initialize lists the read and write tools", { timeout: 15_000 }, async () => {
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
    const listed = await client.listTools(undefined, { timeout: 10_000 });
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...MCP_TOOL_NAMES].sort(),
    );
  } finally {
    await client.close();
  }
});
