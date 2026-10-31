import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CommandError,formatReviewSubmitError,REVIEW_JOB_ENVELOPE_SCHEMA } from "mergestorm/client";
import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { createMergestormMcpServer,fail,MCP_TOOL_NAMES } from "./server.js";

describe("server-contract", { concurrency: false }, () => {
  const failures: Array<{ name: string; thrown: unknown; error: Record<string, unknown> }> = [
    {
      name: "installation refusal",
      thrown: new CommandError("Install Mergestorm Surge.", 1, "cyclone_not_connected", { reason: "surge_not_connected" }),
      error: { code: "cyclone_not_connected", message: "Install Mergestorm Surge.", exit_code: 1, reason: "surge_not_connected" },
    },
    {
      name: "rate limit with server-provided delay",
      thrown: new CommandError("Wait for a running review.", 7, "rate_limited", { retryAfterSeconds: 9 }),
      error: { code: "rate_limited", message: "Wait for a running review.", exit_code: 7, retry_after_seconds: 9 },
    },
    {
      name: "explicit zero delay and empty reason",
      thrown: new CommandError("Busy.", 1, "busy", { retryAfterSeconds: 0, reason: "" }),
      error: { code: "busy", message: "Busy.", exit_code: 1, retry_after_seconds: 0, reason: "" },
    },
    {
      name: "timeout with uncertain write outcome",
      thrown: new CommandError("Request timed out.", 1, "api_timeout"),
      error: { code: "api_timeout", message: "Request timed out.", exit_code: 1 },
    },
    {
      name: "command failure without a code",
      thrown: new CommandError("Unavailable."),
      error: { message: "Unavailable.", exit_code: 1 },
    },
    {
      name: "unexpected error",
      thrown: new Error("Unexpected failure."),
      error: { message: "Unexpected failure." },
    },
    {
      name: "non-error throw",
      thrown: "Unknown failure.",
      error: { message: "Unknown failure." },
    },
  ];

  for (const { name, thrown, error } of failures) {
    test(`tool failure preserves known fields for structured and text-only clients: ${name}`, () => {
      const result = fail(thrown);
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { error });
      assert.deepEqual(JSON.parse(result.content[1]!.text), result.structuredContent);
      assert.ok(result.content[0]!.text.includes(String(error.message)));
      assert.equal("retryable" in result.structuredContent.error, false);
      assert.equal("request_id" in result.structuredContent.error, false);
    });
  }
});

describe("handlers", { concurrency: false }, () => {

  const cfg = {
    apiKey: "msk_live_test_mcp_key",
    apiBase: "https://api.example.test",
  };

  let originalFetch: typeof globalThis.fetch | undefined;
  let originalApiKey: string | undefined;

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = undefined;
    }
    if (originalApiKey === undefined) delete process.env.MERGESTORM_API_KEY;
    else process.env.MERGESTORM_API_KEY = originalApiKey;
    originalApiKey = undefined;
  });

  function mockFetch(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    originalFetch ??= globalThis.fetch;
    globalThis.fetch = async (input) =>
      new Response(JSON.stringify(
        String(input).includes("/stacks/queue") && status === 200 && body && typeof body === "object" && "stacks" in body
          ? { entries: [] }
          : body,
      ), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      });
  }

  const settingsBody = {
    ignored_bot_logins: ["renovate"],
    vortex_bot_skip_check: "none",
    vortex_findings_check: "neutral",
    cyclone_patch_failure_check: "failure",
    auto_review_enabled: true,
    auto_patch_enabled: false,
    auto_resolve_conflicts_enabled: false,
    auto_fix_ci_enabled: false,
    vortex_show_thinking_traces: false,
    repo_overview_enabled: true,
    review_unit_land_prs_enabled: false,
    cyclone_skip_ci_enabled: true,
    cyclone_patch_unverified_languages: false,
    vortex_seam_specialist_enabled: true,
    auto_land_default: false,
    auto_land_settle_seconds: 60,
    merge_queue_batch_enabled: false,
    merge_queue_batch_size: 4,
    merge_queue_lands_alone_paths: ["**/migrations/**", "db/migrate/**", ".github/workflows/**"],
    merge_queue_overdrive: false,
    issue_review_enabled: false,
    cyclone_connected: true,
    github_connected: true,
  };

  test("MCP whoami returns an error payload when live account details are unavailable", async () => {
    originalApiKey = process.env.MERGESTORM_API_KEY;
    process.env.MERGESTORM_API_KEY = cfg.apiKey;
    mockFetch(404, { error: "not_found" });
    const server = createMergestormMcpServer();
    const client = new Client({ name: "whoami-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: "whoami", arguments: {} });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { error: { message: "Live account details unavailable. Could not verify account with /me.", exit_code: 1 } });
      assert.match(JSON.stringify(result.content), /Live account details unavailable/);
      assert.doesNotMatch(JSON.stringify(result), /key_prefix|usage/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("the shared tool failure text carries a refusal's reason next to its code", () => {
    const surge = new CommandError("Install Mergestorm Surge.", 1, "cyclone_not_connected", { reason: "surge_not_connected" });
    const result = fail(surge);
    assert.equal(result.isError, true);
    assert.equal(result.content[0]!.text, "Mergestorm request failed (cyclone_not_connected, reason surge_not_connected): Install Mergestorm Surge..");
    assert.deepEqual(result.structuredContent, {
      error: {
        code: "cyclone_not_connected",
        message: "Install Mergestorm Surge.",
        exit_code: 1,
        reason: "surge_not_connected",
      },
    });
    assert.equal(
      fail(new CommandError("Connect Cyclone.", 1, "cyclone_not_connected")).content[0]!.text,
      "Mergestorm request failed (cyclone_not_connected): Connect Cyclone..",
    );
  });

  test("MCP stack_adopt rejects missing target fields before calling the API", async () => {
    originalFetch ??= globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return Response.json({}); };
    const server = createMergestormMcpServer();
    const client = new Client({ name: "adopt-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const key of ["owner", "repo", "pr_number"]) {
        const args: Record<string, unknown> = { owner: "acme", repo: "widgets", pr_number: 42 };
        delete args[key];
        const result = await client.callTool({ name: "stack_adopt", arguments: args });
        assert.equal(result.isError, true);
      }
      assert.equal(calls, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("MCP settings_set schema accepts auto_land_settle_seconds over transport and bounds it", async () => {
    originalApiKey = process.env.MERGESTORM_API_KEY;
    process.env.MERGESTORM_API_KEY = cfg.apiKey;
    originalFetch ??= globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      assert.deepEqual(JSON.parse(String(init?.body)), { auto_land_settle_seconds: 30 });
      return Response.json({ ...settingsBody, auto_land_settle_seconds: 30 });
    };
    const server = createMergestormMcpServer();
    const client = new Client({ name: "settings-settle-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: "settings_set", arguments: { auto_land_settle_seconds: 30 } });
      assert.ok(!result.isError);
      assert.equal((result.structuredContent as Record<string, unknown>).auto_land_settle_seconds, 30);
      for (const value of [14, 301]) {
        const rejected = await client.callTool({ name: "settings_set", arguments: { auto_land_settle_seconds: value } });
        assert.equal(rejected.isError, true);
      }
      assert.equal(calls, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("MCP settings_set schema accepts lists and enums over transport", async () => {
    originalApiKey = process.env.MERGESTORM_API_KEY;
    process.env.MERGESTORM_API_KEY = cfg.apiKey;
    originalFetch ??= globalThis.fetch;
    const patch = { ignored_bot_logins: ["renovate"], vortex_findings_check: "failure", vortex_bot_skip_check: "neutral", cyclone_patch_failure_check: "neutral" };
    globalThis.fetch = async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), patch);
      return Response.json({ ...settingsBody, ...patch });
    };
    const server = createMergestormMcpServer();
    const client = new Client({ name: "settings-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: "settings_set", arguments: patch });
      assert.ok(!result.isError);
      assert.deepEqual(result.structuredContent, { ...settingsBody, ...patch });
      for (const key of ["cyclone_connected", "github_connected"]) {
        const rejected = await client.callTool({ name: "settings_set", arguments: { ...patch, [key]: true } });
        assert.equal(rejected.isError, true);
        assert.match(JSON.stringify(rejected.content), /read-only/);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("review-pr", { concurrency: false }, () => {

  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  });

  describe("PR review tools", { concurrency: false }, () => {

    test("registers PR review tools without changing stack tools", () => {
      assert.equal((MCP_TOOL_NAMES as readonly string[]).includes("review_get_pr"), false);
      assert.equal((MCP_TOOL_NAMES as readonly string[]).includes("review_get"), false);
      assert.ok(MCP_TOOL_NAMES.includes("review_wait_pr"));
      assert.ok(MCP_TOOL_NAMES.includes("queue_status"));
      assert.deepEqual(
        MCP_TOOL_NAMES.filter((name) => name.startsWith("stack_")),
        ["stack_adopt", "stack_enqueue", "stack_list", "stack_publish", "stack_publish_status", "stack_restack", "stack_set", "stack_status", "stack_wait"],
      );
    });
  });
});

describe("review-write", { concurrency: false }, () => {
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

  function mockReviewFetch(
    responses: { status: number; body: unknown; raw?: boolean; headers?: Record<string, string> }[],
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
      return new Response(r.raw ? String(r.body) : JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json", ...r.headers },
      });
    };
    return { calls: () => n, posts: () => posts };
  }

  describe("review write tools", { concurrency: false }, () => {

    for (const response of [
      { status: 413, body: "<html><body>413 Request Entity Too Large</body></html>", raw: true,
        headers: { "Content-Type": "text/html" } },
      { status: 413, body: { message: "Review payload too large" } },
    ]) {
      test(`review_submit handler preserves structured failure for ${response.raw ? "HTML" : "JSON"} 413`, async () => {
        const previousKey = process.env.MERGESTORM_API_KEY;
        process.env.MERGESTORM_API_KEY = cfg.apiKey;
        const server = createMergestormMcpServer();
        const client = new Client({ name: "review-submit-test", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
          const mock = mockReviewFetch([response]);
          await server.connect(serverTransport);
          await client.connect(clientTransport);
          const result = await client.callTool({
            name: "review_submit",
            arguments: { diff: "diff --git a/a b/a\n+changed\n", base: "main" },
          });
          assert.equal(result.isError, true);
          const data = (result.structuredContent ?? {}) as Record<string, unknown>;
          assert.equal(data.schema, REVIEW_JOB_ENVELOPE_SCHEMA);
          assert.equal(data.status, "failed");
          const error = String(data.error);
          assert.equal(error, formatReviewSubmitError(413, response.raw ? {} : response.body));
          assert.notEqual(error, "{}");
          assert.match(error, /no credits were charged/i);
          assert.match(error, /before a review job was created|No review job was created/);
          if (response.raw) assert.match(error, /HTTP 413/);
          else assert.match(error, /Review payload too large/);
          assert.equal(mock.calls(), 1);
        } finally {
          await client.close();
          await server.close();
          if (previousKey === undefined) delete process.env.MERGESTORM_API_KEY;
          else process.env.MERGESTORM_API_KEY = previousKey;
        }
      });
    }
  });
});
