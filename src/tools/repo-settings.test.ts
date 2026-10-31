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
  merge_queue_batch_enabled: null,
  merge_queue_batch_size: null,
  merge_queue_lands_alone_paths: null,
  merge_queue_overdrive: null,
  issue_review_enabled: null,
};

const MQ_INHERIT =
  "merge_queue_batch inherit · merge_queue_overdrive inherit · issue_review inherit · merge_queue_batch_size inherit · merge_queue_lands_alone_paths inherit";

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
  assert.equal(result.summary, `acme/app: auto_patch off · auto_review inherit · auto_land on · ${MQ_INHERIT}`);
  assert.deepEqual(result.data, ENTRY);
});

test("repo_settings_set PATCHes the merge queue overrides and prints their values", async () => {
  const seen: Array<{ body: unknown }> = [];
  globalThis.fetch = async (_input, init) => {
    seen.push({ body: JSON.parse(String(init?.body)) });
    return Response.json({ ...ENTRY, merge_queue_batch_enabled: true, merge_queue_batch_size: 6, merge_queue_lands_alone_paths: ["db/migrate/**", "**/*.sql"] });
  };
  const result = await repoSettingsSet(
    { repo: "acme/app", merge_queue_batch: true, merge_queue_batch_size: 6, merge_queue_lands_alone_paths: ["db/migrate/**", "**/*.sql"] },
    cfg,
  );
  assert.deepEqual(seen, [
    { body: { merge_queue_batch_enabled: true, merge_queue_batch_size: 6, merge_queue_lands_alone_paths: ["db/migrate/**", "**/*.sql"] } },
  ]);
  assert.equal(
    result.summary,
    "acme/app: auto_patch off · auto_review inherit · auto_land on · merge_queue_batch on · merge_queue_overdrive inherit · issue_review inherit · merge_queue_batch_size 6 · merge_queue_lands_alone_paths db/migrate/**,**/*.sql",
  );
  assert.throws(() => repoSettingsPatchFromArgs({ merge_queue_batch_size: 2.5 }), /merge_queue_batch_size takes a whole number or null/);
  assert.throws(() => repoSettingsPatchFromArgs({ merge_queue_lands_alone_paths: "db" }), /merge_queue_lands_alone_paths takes a list of path patterns or null/);
  assert.deepEqual(repoSettingsPatchFromArgs({ merge_queue_lands_alone_paths: [] }), { merge_queue_lands_alone_paths: [] });
});

test("repo_settings_set refuses a missing repository, no switches and a value that is not true, false or null", async () => {
  await assert.rejects(() => repoSettingsSet({ auto_patch: false }, cfg), /repo takes <owner>\/<repo>/);
  assert.throws(() => repoSettingsPatchFromArgs({}), /At least one of auto_patch, auto_review, auto_land, merge_queue_batch, merge_queue_batch_size, merge_queue_lands_alone_paths, merge_queue_overdrive, issue_review is required/);
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
    `acme/app: auto_patch off · auto_review inherit · auto_land on · ${MQ_INHERIT}\nacme/other: auto_patch inherit · auto_review inherit · auto_land on · ${MQ_INHERIT}`,
  );
  const one = await repoSettingsGet({ repo: "Acme/App" }, cfg);
  assert.deepEqual(one.data, ENTRY);
  await assert.rejects(() => repoSettingsGet({ repo: "acme/missing" }, cfg), /acme\/missing is not connected to this account/);
});

test("repo_settings_set sets or clears a repository's merge queue overdrive", async () => {
  const seen: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    seen.push(JSON.parse(String(init?.body)));
    return Response.json({ ...ENTRY, merge_queue_overdrive: true });
  };
  const result = await repoSettingsSet({ repo: "acme/app", merge_queue_overdrive: true }, cfg);
  assert.match(result.summary, / · merge_queue_overdrive on · /);
  assert.deepEqual(repoSettingsPatchFromArgs({ merge_queue_overdrive: null }), { merge_queue_overdrive: null });
  assert.throws(() => repoSettingsPatchFromArgs({ merge_queue_overdrive: "on" }), /merge_queue_overdrive takes true, false, or null/);
  assert.deepEqual(seen, [{ merge_queue_overdrive: true }]);
});

test("repo_settings_set sets or clears a repository's Vortex issue reviews", async () => {
  const seen: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    seen.push(JSON.parse(String(init?.body)));
    return Response.json({ ...ENTRY, issue_review_enabled: true });
  };
  const result = await repoSettingsSet({ repo: "acme/app", issue_review: true }, cfg);
  assert.match(result.summary, / · issue_review on · /);
  assert.equal(result.data.issue_review_enabled, true);
  assert.deepEqual(repoSettingsPatchFromArgs({ issue_review: null }), { issue_review_enabled: null });
  assert.deepEqual(repoSettingsPatchFromArgs({ issue_review: false }), { issue_review_enabled: false });
  assert.throws(() => repoSettingsPatchFromArgs({ issue_review: "on" }), /issue_review takes true, false, or null/);
  assert.deepEqual(seen, [{ issue_review_enabled: true }]);
});
