import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "mergestorm/client";
import { issueCreate } from "./issue-create.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test" };

test("issue_create opens the issue on the named repository and tells the agent how to link it", async () => {
  const sent: unknown[] = [];
  const result = await issueCreate({ owner: "acme", repo: "widgets", title: "Fix it", body: "Details", labels: ["bug"] }, CFG, {
    openStackIssue: async (input, cfg) => {
      sent.push({ input, cfg });
      return { number: 12, url: "https://github.com/acme/widgets/issues/12", created: true };
    },
    parseGithubOriginRepo: () => {
      throw new Error("origin must not be read when owner and repo are given");
    },
  });
  assert.deepEqual(sent, [{ input: { owner: "acme", repo: "widgets", title: "Fix it", body: "Details", labels: ["bug"] }, cfg: CFG }]);
  assert.deepEqual(result.data, { owner: "acme", repo: "widgets", number: 12, url: "https://github.com/acme/widgets/issues/12", created: true });
  assert.equal(result.summary, 'Opened acme/widgets#12 https://github.com/acme/widgets/issues/12. Put "Fixes #12" in the commit or pull request body.');
});

test("issue_create falls back to the origin repository and reports an issue it already opened", async () => {
  const result = await issueCreate({ title: "Fix it", cwd: "/repo" }, CFG, {
    parseGithubOriginRepo: (cwd) => (cwd === "/repo" ? { owner: "acme", repo: "widgets" } : null),
    openStackIssue: async (input) => {
      assert.deepEqual(input, { owner: "acme", repo: "widgets", title: "Fix it", body: "", labels: [] });
      return { number: 12, url: "u", created: false };
    },
  });
  assert.match(result.summary, /^Already open: acme\/widgets#12/);
  assert.equal(result.data.created, false);
});

test("issue_create rejects bad input before any request and reports a refusal with its code", async () => {
  let called = 0;
  const deps = {
    parseGithubOriginRepo: () => null,
    openStackIssue: async () => {
      called += 1;
      return { number: 1, url: "u", created: true };
    },
  };
  for (const bad of [{ title: "" }, { title: "T", owner: "acme" }, { title: "T" }]) {
    const result = await issueCreate(bad, CFG, deps);
    assert.equal(result.isError, true);
    assert.equal((result.data.error as { code: string }).code, "invalid_input");
  }
  assert.equal(called, 0);
  const refused = await issueCreate({ owner: "acme", repo: "widgets", title: "T" }, CFG, {
    openStackIssue: async () => {
      throw new CommandError("Rate limited.", 7, "rate_limited", { retryAfterSeconds: 12 });
    },
  });
  assert.deepEqual(refused.data.error, { code: "rate_limited", message: "Rate limited.", retry_after_seconds: 12 });
});
