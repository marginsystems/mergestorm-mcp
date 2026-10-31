import { CommandError } from "mergestorm/client";
import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { whoami } from "./whoami.js";

describe("handlers", { concurrency: false }, () => {

  const cfg = {
    apiKey: "msk_live_test_mcp_key",
    apiBase: "https://api.example.test",
  };

  const meBody = {
    account: { github_login: "marginsystems", email: "mark@example.com" },
    key: {
      prefix: "msk_live_te",
      name: "ci",
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: null,
    },
    plan_key: "starter",
    plan_label_key: "Starter",
    resets_at: "2026-09-01T00:00:00.000Z",
    usage: {
      standard: { used: 3, limit: 40, remaining: 37 },
      bonus: { remaining: 9 },
    },
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

  test("whoami returns key prefix and plan without a job envelope", async () => {
    mockFetch(200, meBody);
    const result = await whoami(cfg);
    assert.match(result.summary, /^marginsystems · msk_live_te/);
    assert.match(result.summary, /Starter/);
    assert.equal(result.data.account, "marginsystems");
    assert.equal(result.data.github_login, "marginsystems");
    assert.equal(result.data.email, "mark@example.com");
    assert.equal(result.data.key_prefix, "msk_live_te");
    assert.equal(result.data.plan_key, "starter");
    assert.equal(result.data.schema, undefined);
  });

  test("whoami reports the running server version so a stale MCP process is visible", async () => {
    mockFetch(200, meBody);
    const result = await whoami(cfg, "9.9.9");
    assert.equal(result.data.mcp_server_version, "9.9.9");
    assert.match(result.summary, /mergestorm-mcp 9\.9\.9/);
  });

  test("whoami throws when no API key is configured", async () => {
    originalApiKey = process.env.MERGESTORM_API_KEY;
    delete process.env.MERGESTORM_API_KEY;
    await assert.rejects(
      () => whoami({}),
      (err: unknown) => err instanceof CommandError && err.code === "missing_api_key",
    );
  });

  for (const failure of ["404", "network", "timeout", "401"] as const) {
    test(`whoami rejects ${failure} instead of returning cached account metadata`, async () => {
      if (failure === "404" || failure === "401") {
        mockFetch(Number(failure), { error: "unavailable" });
      } else {
        originalFetch = globalThis.fetch;
        globalThis.fetch = async () => {
          if (failure === "timeout") {
            throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
          }
          throw new TypeError("fetch failed");
        };
      }
      await assert.rejects(() => whoami(cfg), (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.notEqual(err.exitCode, 0);
        if (failure === "401") assert.equal(err.code, "auth_invalid");
        else assert.match(err.message, /Live account details unavailable/);
        return true;
      });
    });
  }
});
