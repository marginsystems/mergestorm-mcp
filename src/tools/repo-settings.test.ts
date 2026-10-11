import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CommandError } from "mergestorm/client";
import { repoSettingsGet, repoSettingsPatchFromArgs, repoSettingsSet } from "./repo-settings.js";

const cfg = {
  apiBase: "https://api.example.test",
  apiKey: "msk_live_test_key",
  keySource: "env" as const,
  configPath: "/tmp/mergestorm-test-config.json",
};

const ENTRY = {
  owner: "acme",
  repo: "app",
  auto_patch_enabled: false,
  auto_review_enabled: null,
  auto_land_default: true,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("repo_settings_set PATCHes the named repository with only the given switches", async () => {
  const seen: Array<{ url: string; method?: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json(ENTRY);
  };
  const result = await repoSettingsSet({ repo: "acme/app", auto_patch: false, auto_review: null }, cfg);
  assert.deepEqual(seen, [
    {
      url: "https://api.example.test/api/v1/settings/repos/acme/app",
      method: "PATCH",
      body: { auto_patch_enabled: false, auto_review_enabled: null },
    },
  ]);
  assert.equal(result.summary, "acme/app: auto_patch off · auto_review inherit · auto_land on");
  assert.deepEqual(result.data, ENTRY);
});

test("repo_settings_set refuses a missing repository, no switches and a value that is not true, false or null", async () => {
  await assert.rejects(() => repoSettingsSet({ auto_patch: false }, cfg), /repo takes <owner>\/<repo>/);
  assert.throws(() => repoSettingsPatchFromArgs({}), /At least one of auto_patch, auto_review, auto_land is required/);
  assert.throws(() => repoSettingsPatchFromArgs({ auto_patch: "off" }), /auto_patch takes true, false, or null/);
});

test("repo_settings_set surfaces the API message when the account did not connect the repository", async () => {
  globalThis.fetch = async () =>
    Response.json({ error: "repo_not_connected", message: "acme/app is not connected to this account." }, { status: 404 });
  await assert.rejects(
    () => repoSettingsSet({ repo: "acme/app", auto_patch: false }, cfg),
    (err: unknown) => err instanceof CommandError && /acme\/app is not connected to this account/.test(err.message),
  );
});

test("repo_settings_get lists every connected repository, or one by name", async () => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://api.example.test/api/v1/settings/repos");
    return Response.json({ repos: [ENTRY, { ...ENTRY, repo: "other", auto_patch_enabled: null }] });
  };
  const all = await repoSettingsGet({}, cfg);
  assert.equal(
    all.summary,
    "acme/app: auto_patch off · auto_review inherit · auto_land on\nacme/other: auto_patch inherit · auto_review inherit · auto_land on",
  );
  const one = await repoSettingsGet({ repo: "Acme/App" }, cfg);
  assert.deepEqual(one.data, ENTRY);
  await assert.rejects(() => repoSettingsGet({ repo: "acme/missing" }, cfg), /acme\/missing is not connected to this account/);
});
