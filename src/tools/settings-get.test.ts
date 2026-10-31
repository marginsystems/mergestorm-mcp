import { CommandError } from "mergestorm/client";
import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { settingsGet } from "./settings-get.js";

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

  test("settings_get returns the settings allowlist with an actionable summary", async () => {
    mockFetch(200, settingsBody);
    const result = await settingsGet(cfg);
    assert.equal(result.summary, "auto_patch off · Cyclone connected");
    assert.deepEqual(result.data, settingsBody);
    assert.equal(result.data.auto_patch_enabled, false);
    assert.equal(result.data.cyclone_connected, true);
  });

  test("settings_get names the enabled Cyclone automations in the summary", async () => {
    mockFetch(200, { ...settingsBody, auto_resolve_conflicts_enabled: true, auto_fix_ci_enabled: true });
    assert.equal(
      (await settingsGet(cfg)).summary,
      "auto_patch off · auto_resolve_conflicts on · auto_fix_ci on · Cyclone connected",
    );
  });

  test("settings_get says whether stacks, the merge queue and Auto land are ready when the server reports it", async () => {
    mockFetch(200, { ...settingsBody, cyclone_connected: false, stacks_ready: true });
    const ready = await settingsGet(cfg);
    assert.equal(
      ready.summary,
      "auto_patch off · Cyclone not connected (auto patch) · stacks, merge queue and Auto land ready",
    );
    assert.equal(ready.data.stacks_ready, true);

    mockFetch(200, { ...settingsBody, stacks_ready: false });
    assert.equal(
      (await settingsGet(cfg)).summary,
      "auto_patch off · Cyclone connected (auto patch) · stacks, merge queue and Auto land not ready (install Mergestorm Surge)",
    );
  });

  test("settings_get surfaces auto_patch on in the summary", async () => {
    mockFetch(200, {
      ...settingsBody,
      auto_patch_enabled: true,
      cyclone_connected: false,
    });
    const result = await settingsGet(cfg);
    assert.equal(result.summary, "auto_patch on · Cyclone not connected");
  });

  test("settings_get throws when the settings API is unavailable", async () => {
    mockFetch(404, { error: "not_found" });
    await assert.rejects(
      () => settingsGet(cfg),
      (err: unknown) =>
        err instanceof CommandError && /Settings are not available/.test(err.message),
    );
  });
});
