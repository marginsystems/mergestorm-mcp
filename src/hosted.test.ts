import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_HOSTED_SERVER_INSTRUCTIONS, MCP_HOSTED_TOOL_NAMES, MCP_SERVER_INSTRUCTIONS, handleHostedMcpRequest } from "./hosted.js";
import { MCP_TOOL_NAMES, MCP_WORKSPACE_TOOL_NAMES } from "./server.js";

const CALLER_KEY = "msk_live_caller_aaaaaaaaaaaaaaaaaaaa";
const ENV_KEY = "msk_live_process_env_bbbbbbbbbbbbbbbb";

async function fakeApi(t: { after: (fn: () => Promise<void> | void) => void }) {
  const seen: { url: string; authorization: string | undefined }[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    seen.push({ url: request.url!, authorization: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${CALLER_KEY}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (request.url === "/api/v1/me") {
      response.end(JSON.stringify({ key: { prefix: "msk_live_call", name: "Breeze chat" }, plan_key: "pro" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function inProcessClient(apiBase: string, apiKey: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.test/api/v1/mcp"), {
    fetch: async (input, init) => handleHostedMcpRequest(new Request(input, init), { apiKey, apiBase }),
  });
  const client = new Client({ name: "hosted-test", version: "0.0.0" });
  return client.connect(transport).then(() => client);
}

test("hosted whoami answers as the calling key, never the process MERGESTORM_API_KEY", async (t) => {
  const api = await fakeApi(t);
  const savedKey = process.env.MERGESTORM_API_KEY;
  const savedUrl = process.env.MERGESTORM_API_URL;
  process.env.MERGESTORM_API_KEY = ENV_KEY;
  process.env.MERGESTORM_API_URL = "http://127.0.0.1:1";
  t.after(() => {
    if (savedKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = savedKey;
    if (savedUrl === undefined) delete process.env.MERGESTORM_API_URL;
    else process.env.MERGESTORM_API_URL = savedUrl;
  });
  const client = await inProcessClient(api.base, CALLER_KEY);
  t.after(() => client.close());

  const result = await client.callTool({ name: "whoami", arguments: {} });
  assert.notEqual(result.isError, true);
  const data = result.structuredContent as Record<string, unknown>;
  assert.equal(data.key_prefix, "msk_live_call");
  assert.equal(data.api_base, api.base);
  assert.equal(data.config_path, null);
  assert.deepEqual(api.seen, [{ url: "/api/v1/me", authorization: `Bearer ${CALLER_KEY}` }]);
});

test("hosted endpoint lists every tool except the ones that read the local workspace", async (t) => {
  const api = await fakeApi(t);
  const client = await inProcessClient(api.base, CALLER_KEY);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...MCP_HOSTED_TOOL_NAMES].sort());
  for (const name of MCP_WORKSPACE_TOOL_NAMES) assert.ok(!names.includes(name), name);
  assert.equal(MCP_HOSTED_TOOL_NAMES.length, MCP_TOOL_NAMES.length - MCP_WORKSPACE_TOOL_NAMES.length);
  const issue = tools.find((tool) => tool.name === "issue_create");
  assert.ok(issue);
  assert.ok(!("cwd" in (issue.inputSchema.properties ?? {})));
  assert.deepEqual([...(issue.inputSchema.required ?? [])].sort(), ["owner", "repo", "title"]);
  assert.equal(tools.find((tool) => tool.name === "stack_status")?.annotations?.readOnlyHint, true);
});

test("hosted whoami with a key the API refuses returns the auth error, not another account", async (t) => {
  const api = await fakeApi(t);
  const client = await inProcessClient(api.base, "msk_live_wrong_cccccccccccccccccccc");
  t.after(() => client.close());
  const result = await client.callTool({ name: "whoami", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { error: { code?: string } }).error.code, "auth_invalid");
});

test("hosted endpoint refuses GET because it keeps no session stream", async () => {
  const response = await handleHostedMcpRequest(new Request("https://mcp.test/api/v1/mcp", { method: "GET" }), {
    apiKey: CALLER_KEY,
    apiBase: "http://127.0.0.1:1",
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("hosted endpoint sends instructions for an agent with no checkout and no mg", async (t) => {
  const api = await fakeApi(t);
  const client = await inProcessClient(api.base, CALLER_KEY);
  t.after(() => client.close());
  const instructions = client.getInstructions();
  assert.equal(instructions, MCP_HOSTED_SERVER_INSTRUCTIONS);
  assert.notEqual(instructions, MCP_SERVER_INSTRUCTIONS);
  for (const kept of [
    /A stack is done only when it is landed, or when the human takes it back/,
    /The stack is landed only when its land PR \(head mg-stack-<n>\) merges into main/,
    /While watch\.done is false, call stack_wait with watch\.next\.args/,
    /attention means a layer needs a fix/,
    /in_progress means Vortex or Cyclone is still working on it/,
    /A pending land gate \(landGatePending\) is a wait, not attention/,
    /Dismiss a finding only after you checked it against the PR's live head/,
    /A finding a human must decide \(Decision required, policy fork, needs a human\) stays open/,
  ]) assert.match(instructions ?? "", kept);
  for (const dropped of [/\bmg\b(?!-)/, /MS-WATCH/, /background/, /checkout/, /patch/, /push/]) assert.doesNotMatch(instructions ?? "", dropped);
});

test("hosted tool descriptions are short, say what comes back, and carry no local-agent text", async (t) => {
  const api = await fakeApi(t);
  const client = await inProcessClient(api.base, CALLER_KEY);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.ok(!byName.has("review_wait"));
  for (const tool of tools) {
    assert.doesNotMatch(tool.description ?? "", /See server instructions|Do not pass 300|hosts drop long MCP calls|background watching|mg review|smallest correct patch/, tool.name);
  }
  for (const name of ["stack_wait", "stack_status", "review_dismiss"]) {
    assert.ok((byName.get(name)?.description ?? "").length <= 800, `${name}: ${byName.get(name)?.description?.length}`);
  }
  assert.match(byName.get("stack_wait")!.description!, /watch\.done true means stop/);
  assert.match(byName.get("review_dismiss")!.description!, /evidence_url set to an open tracking issue/);
  const timeout = (name: string) => (byName.get(name)!.inputSchema.properties as Record<string, { maximum?: number }>).timeout_s;
  assert.equal(timeout("stack_wait")?.maximum, 45);
  assert.equal(timeout("review_wait_pr")?.maximum, 45);
});
