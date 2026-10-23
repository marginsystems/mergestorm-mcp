import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError, type ServerPublishResult } from "mergestorm/client";
import { stackPublish, stackPublishStatus } from "./stack-publish.js";

const CFG = { apiKey: "msk_live_test", apiBase: "https://api.example.test" };
const TARGET = { owner: "acme", repo: "widgets", branch: "dot/feature" };

function published(branch: string, baseBranch: string): ServerPublishResult {
  return {
    state: "registered",
    owner: "acme",
    repo: "widgets",
    branch,
    base: { branch: baseBranch, sha: "b".repeat(40) },
    baseBranch,
    head: { sha: "a".repeat(40), tree: "e".repeat(40) },
    commits: [{ sha: "a".repeat(40), tree: "e".repeat(40) }],
    branchCreated: true,
    branchUpdated: false,
    pr: { number: 77, url: "https://github.com/acme/widgets/pull/77", created: true },
    stack: { id: "33333333-3333-4333-8333-333333333333", autoPatchOverride: null, autoLand: true },
  };
}

test("stack_publish sends the named branch through Mergestorm and returns the verified result with the watch obligation", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const result = await stackPublish(
    { ...TARGET, cwd: "/repo", base: "main", title: "Add the logo", body: "Fixes #7", auto_land: false, replace_head: "c".repeat(40) },
    CFG,
    {
      discoverTrunk: () => "main",
      publishBranchServerSide: async (input) => {
        sent.push(input);
        return published(input.branch, input.baseBranch);
      },
    },
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(sent, [
    {
      cfg: CFG,
      cwd: "/repo",
      owner: "acme",
      repo: "widgets",
      branch: "dot/feature",
      baseBranch: "main",
      title: "Add the logo",
      body: "Fixes #7",
      autoLand: false,
      replaceHead: "c".repeat(40),
    },
  ]);
  const data = result.data as { result: ServerPublishResult; watch: { done: boolean; next: { args: { stack_id: string } } } };
  assert.equal(data.result.stack.autoPatchOverride, null);
  assert.equal(data.result.head.tree, "e".repeat(40));
  assert.equal(data.watch.done, false);
  assert.equal(data.watch.next.args.stack_id, "33333333-3333-4333-8333-333333333333");
  assert.match(result.summary, /^This stack is not landed\. Your task is not done\./);
  assert.match(result.summary, /PR #77 \(a single PR onto main\), stack 33333333-3333-4333-8333-333333333333/);
});

test("stack_publish stacks onto a base other than trunk only with extend, and says so", async () => {
  const bases: string[] = [];
  const deps = {
    discoverTrunk: () => "main",
    publishBranchServerSide: async (input: { branch: string; baseBranch: string }) => {
      bases.push(input.baseBranch);
      return published(input.branch, input.baseBranch);
    },
  };
  const refused = await stackPublish({ ...TARGET, base: "dot/lower", title: "t", body: "" }, CFG, deps);
  assert.equal(refused.isError, true);
  assert.equal((refused.data.error as { code: string }).code, "implicit_stack");
  assert.deepEqual(bases, []);

  const stacked = await stackPublish({ ...TARGET, base: "dot/lower", extend: true, title: "t", body: "" }, CFG, deps);
  assert.equal(stacked.isError, undefined);
  assert.deepEqual(bases, ["dot/lower"]);
  assert.match(stacked.summary, /PR #77 \(a layer stacked on dot\/lower\)/);
});

test("stack_publish reports a refused publication with its code and rejects malformed input before reading anything", async () => {
  const refused = await stackPublish({ ...TARGET, base: "main", title: "t", body: "" }, CFG, {
    discoverTrunk: () => "main",
    publishBranchServerSide: async () => {
      throw new CommandError("dot/feature on GitHub is at d00d", 1, "head_changed");
    },
  });
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.data.error, { code: "head_changed", message: "dot/feature on GitHub is at d00d" });

  let called = 0;
  const deps = {
    discoverTrunk: () => "main",
    publishBranchServerSide: async () => {
      called += 1;
      return published("x", "main");
    },
  };
  for (const bad of [{ owner: "acme" }, { ...TARGET, replace_head: "abc123" }]) {
    const invalid = await stackPublish(bad, CFG, deps);
    assert.equal(invalid.isError, true);
    assert.equal((invalid.data.error as { code: string }).code, "invalid_input");
  }
  assert.equal(called, 0);
});

test("stack_publish_status reads one branch's publication and changes nothing", async () => {
  const asked: unknown[] = [];
  const result = await stackPublishStatus(TARGET, CFG, {
    getStackPublication: async (_cfg, input) => {
      asked.push(input);
      return {
        state: "opened",
        ...TARGET,
        head: { sha: "a".repeat(40), tree: "e".repeat(40) },
        pr: { number: 77, url: "https://github.com/acme/widgets/pull/77", base: "main" },
        stack: null,
      };
    },
  });
  assert.deepEqual(asked, [TARGET]);
  assert.equal((result.data.status as { state: string }).state, "opened");
  assert.equal(result.summary, `acme/widgets dot/feature: opened at ${"a".repeat(40)}, PR #77`);
});
