import { CommandError } from "mergestorm/client";
import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { settingsSet } from "./settings-set.js";

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

  test("settings_set PATCHes only the provided writable keys", async () => {
    const rows: ReadonlyArray<{
      input: Record<string, unknown>;
      body: Record<string, boolean>;
      summary?: string;
    }> = [
      {
        input: { auto_patch_enabled: false, vortex_seam_specialist_enabled: undefined },
        body: { auto_patch_enabled: false },
        summary: "auto_patch off · Cyclone connected",
      },
      {
        input: { auto_patch_enabled: true },
        body: { auto_patch_enabled: true },
        summary: "auto_patch on · Cyclone connected",
      },
      {
        input: { auto_resolve_conflicts_enabled: true, auto_fix_ci_enabled: false },
        body: { auto_resolve_conflicts_enabled: true, auto_fix_ci_enabled: false },
      },
      {
        input: { cyclone_skip_ci_enabled: false },
        body: { cyclone_skip_ci_enabled: false },
      },
      {
        input: { cyclone_patch_unverified_languages: true },
        body: { cyclone_patch_unverified_languages: true },
      },
      {
        input: { auto_land_default: true },
        body: { auto_land_default: true },
      },
    ];

    for (const row of rows) {
      originalFetch ??= globalThis.fetch;
      let method = "";
      let requestUrl = "";
      let requestBody: unknown;
      globalThis.fetch = async (input, init) => {
        requestUrl = String(input);
        method = init?.method ?? "GET";
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ ...settingsBody, ...row.body });
      };

      const result = await settingsSet({ ...row.input }, cfg);
      assert.equal(method, "PATCH");
      assert.deepEqual(requestBody, row.body);
      for (const [key, value] of Object.entries(row.body)) {
        assert.equal(result.data[key], value);
      }
      if ("auto_patch_enabled" in row.body) {
        assert.equal(requestUrl, "https://api.example.test/api/v1/settings");
        assert.equal(result.summary, row.summary);
      }
    }
  });

  test("settings_set with no keys is a usage error", async () => {
    await assert.rejects(
      () => settingsSet({}, cfg),
      (err: unknown) => err instanceof CommandError && err.code === "usage",
    );
  });

  test("settings_set rejects read-only keys", async () => {
    for (const key of ["cyclone_connected", "github_connected"]) {
      await assert.rejects(
        () => settingsSet({ [key]: false }, cfg),
        (err: unknown) =>
          err instanceof CommandError &&
          err.code === "usage" &&
          err.message.includes(`${key} is read-only`),
      );
    }
  });

  test("settings_set rejects non-boolean values for boolean keys as usage errors", async () => {
    await assert.rejects(
      () => settingsSet({ auto_patch_enabled: "off" }, cfg),
      (err: unknown) => err instanceof CommandError && err.code === "usage",
    );
  });

  for (const patch of [
    { vortex_findings_check: "failure" },
    { ignored_bot_logins: ["renovate"] },
  ]) {
    test(`settings_set PATCHes ${JSON.stringify(patch)}`, async () => {
      originalFetch ??= globalThis.fetch;
      globalThis.fetch = async (_input, init) => {
        assert.equal(init?.method, "PATCH");
        assert.deepEqual(JSON.parse(String(init?.body)), patch);
        return Response.json({ ...settingsBody, ...patch });
      };
      const result = await settingsSet(patch, cfg);
      assert.deepEqual(result.data, { ...settingsBody, ...patch });
    });
  }

  test("settings_set rejects wrong list and enum types", async () => {
    for (const patch of [{ ignored_bot_logins: "renovate" }, { ignored_bot_logins: [4] }, { vortex_findings_check: "none" }, { vortex_bot_skip_check: true }]) {
      await assert.rejects(() => settingsSet(patch, cfg), (e: unknown) => e instanceof CommandError && e.code === "usage");
    }
  });

  test("settings_set PATCHes auto_land_settle_seconds and rejects values outside 15 through 300", async () => {
    originalFetch ??= globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      assert.deepEqual(JSON.parse(String(init?.body)), { auto_land_settle_seconds: 30 });
      return Response.json({ ...settingsBody, auto_land_settle_seconds: 30 });
    };
    const result = await settingsSet({ auto_land_settle_seconds: 30 }, cfg);
    assert.equal(result.data.auto_land_settle_seconds, 30);
    for (const value of [14, 301, 30.5, "30", true]) {
      await assert.rejects(
        () => settingsSet({ auto_land_settle_seconds: value }, cfg),
        (e: unknown) => e instanceof CommandError && e.code === "usage" && /15 through 300/.test(e.message),
      );
    }
    assert.equal(calls, 1);
  });

  test("settings_set PATCHes merge queue batching and rejects a batch size outside 2 through 10", async () => {
    originalFetch ??= globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      assert.equal(init?.method, "PATCH");
      assert.deepEqual(JSON.parse(String(init?.body)), { merge_queue_batch_enabled: true, merge_queue_batch_size: 6 });
      return Response.json({ ...settingsBody, merge_queue_batch_enabled: true, merge_queue_batch_size: 6 });
    };
    const result = await settingsSet({ merge_queue_batch_enabled: true, merge_queue_batch_size: 6 }, cfg);
    assert.equal(result.data.merge_queue_batch_enabled, true);
    assert.equal(result.data.merge_queue_batch_size, 6);
    for (const value of [1, 11, 3.5, "4", true]) {
      await assert.rejects(
        () => settingsSet({ merge_queue_batch_size: value }, cfg),
        (err: unknown) =>
          err instanceof Error && err.message === "merge_queue_batch_size takes a whole number from 2 through 10.",
        String(value),
      );
    }
    await assert.rejects(() => settingsSet({ merge_queue_batch_enabled: "on" }, cfg), /merge_queue_batch_enabled takes a boolean/);
    await assert.rejects(() => settingsSet({ merge_queue_overdrive: "on" }, cfg), /merge_queue_overdrive takes a boolean/);
    await assert.rejects(() => settingsSet({ issue_review_enabled: "on" }, cfg), /issue_review_enabled takes a boolean/);
    assert.equal(calls, 1);
  });

  test("settings_set PATCHes merge queue overdrive alone", async () => {
    originalFetch ??= globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { merge_queue_overdrive: true });
      return Response.json({ ...settingsBody, merge_queue_overdrive: true });
    };
    const result = await settingsSet({ merge_queue_overdrive: true }, cfg);
    assert.equal(result.data.merge_queue_overdrive, true);
    assert.equal(result.data.merge_queue_batch_size, 4);
  });

  test("settings_set PATCHes the Vortex issue reviews account default alone", async () => {
    originalFetch ??= globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { issue_review_enabled: true });
      return Response.json({ ...settingsBody, issue_review_enabled: true });
    };
    const result = await settingsSet({ issue_review_enabled: true }, cfg);
    assert.equal(result.data.issue_review_enabled, true);
  });
});
