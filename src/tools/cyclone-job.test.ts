import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CYCLONE_JOB_STILL_RUNNING_NOTE, CYCLONE_START_WAIT_NOTE, cycloneJob, cycloneJobSummary, cycloneStart } from "./cyclone-job.js";
import { chatTaskNote } from "./chat-task.js";

const CHAT = "6a1f0000-0000-4000-8000-000000000001";
const JOB = "7b2e0000-0000-4000-8000-000000000002";
const cfg = { apiKey: "ms_test", apiBase: "https://api.example.test" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("a CI fix sends the task, pull request, failing check and chat, and names the chat's background task instead of polling", async () => {
  const calls = stubFetch(202, { dispatch_id: JOB, state: "queued", background_task: { id: "t1", title: "Fix the failing CI on acme/app#4" }, message: "Cyclone is queued to fix the failing CI on acme/app#4." });
  const payload = await cycloneStart({ task: "fix_ci", owner: "acme", repo: "app", pr_number: 4, failing_check: "unit" }, cfg, CHAT);
  assert.equal(calls[0]!.url, "https://api.example.test/api/v1/agents/cyclone/jobs");
  assert.deepEqual(calls[0]!.body, { task: "fix_ci", owner: "acme", repo: "app", pr_number: 4, failing_check: "unit", chat_id: CHAT });
  assert.equal(payload.summary, `Cyclone is queued to fix the failing CI on acme/app#4. ${chatTaskNote({ id: "t1", title: "Fix the failing CI on acme/app#4" })}`);
});

test("a job started without a chat still says to wait for it, and a job that pushed at once says nothing more", async () => {
  stubFetch(202, { dispatch_id: JOB, state: "queued", background_task: null, message: "Cyclone is queued to fix the review findings on acme/app#4." });
  const queued = await cycloneStart({ task: "fix_findings", owner: "acme", repo: "app", pr_number: 4 }, cfg, null);
  assert.equal(queued.summary, `Cyclone is queued to fix the review findings on acme/app#4. ${CYCLONE_START_WAIT_NOTE}`);
  stubFetch(200, { dispatch_id: JOB, state: "pushed", commit_sha: "a".repeat(40), background_task: { id: "t1", title: "Fix" }, message: "Cyclone pushed aaaaaaaaaa to acme/app#4." });
  const pushed = await cycloneStart({ task: "fix_findings", owner: "acme", repo: "app", pr_number: 4 }, cfg, CHAT);
  assert.equal(pushed.summary, "Cyclone pushed aaaaaaaaaa to acme/app#4.");
});

function stubJobStates(states: Array<Record<string, unknown>>) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const body = states[Math.min(calls, states.length - 1)];
    calls += 1;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return () => calls;
}

function fakeClock() {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => { at += ms; } };
}

test("waiting on a job polls until Cyclone pushes and returns the pushed commit", async () => {
  const job = { dispatch_id: JOB, task: "fix_findings", owner: "acme", repo: "app", pr_number: 79 };
  const calls = stubJobStates([{ ...job, state: "queued" }, { ...job, state: "running" }, { ...job, state: "pushed", outcome: "pushed", result_sha: "d".repeat(40), changed_files: ["src/a.ts"] }]);
  const payload = await cycloneJob(JOB, cfg, 45, { pollMs: 5_000, ...fakeClock() });
  assert.equal(calls(), 3);
  assert.equal(payload.data.state, "pushed");
  assert.deepEqual(payload.data.changed_files, ["src/a.ts"]);
  assert.equal(payload.summary, "Cyclone fix_findings on acme/app#79: pushed (pushed). pushed dddddddddd");
});

test("a wait that runs out while Cyclone works says to call cyclone_job again", async () => {
  const calls = stubJobStates([{ dispatch_id: JOB, task: "fix_findings", owner: "acme", repo: "app", pr_number: 79, state: "running" }]);
  const payload = await cycloneJob(JOB, cfg, 12, { pollMs: 5_000, ...fakeClock() });
  assert.equal(calls(), 4);
  assert.equal(payload.data.state, "running");
  assert.equal(payload.summary, `Cyclone fix_findings on acme/app#79: running. ${CYCLONE_JOB_STILL_RUNNING_NOTE}`);
});

test("timeout_s 0 reads the job once, and a wait never runs past the longest wait", async () => {
  const once = stubJobStates([{ dispatch_id: JOB, owner: "acme", repo: "app", state: "queued" }]);
  await cycloneJob(JOB, cfg, 0, fakeClock());
  assert.equal(once(), 1);
  const clock = fakeClock();
  stubJobStates([{ dispatch_id: JOB, owner: "acme", repo: "app", state: "queued" }]);
  await cycloneJob(JOB, cfg, 10_000, { pollMs: 5_000, ...clock });
  assert.equal(clock.now(), 100_000);
});

test("a failed job is final and is not polled again", async () => {
  const calls = stubJobStates([{ dispatch_id: JOB, task: "resolve_conflicts", owner: "acme", repo: "app", pr_number: 79, state: "failed", outcome: "conflict_too_large", detail: "Too many files." }]);
  const payload = await cycloneJob(JOB, cfg, 45, fakeClock());
  assert.equal(calls(), 1);
  assert.equal(payload.summary, "Cyclone resolve_conflicts on acme/app#79: failed (conflict_too_large). Too many files.");
});

test("a build sends the brief and no pull request", async () => {
  const calls = stubFetch(202, { dispatch_id: JOB, state: "queued", background_task: null, message: "Cyclone is building acme/todo." });
  await cycloneStart({ task: "build", owner: "acme", repo: "todo", brief: "a todo app" }, cfg, null);
  assert.deepEqual(calls[0]!.body, { task: "build", owner: "acme", repo: "todo", brief: "a todo app" });
});

test("reading a job names its state, outcome, pushed commit and detail", async () => {
  const calls = stubFetch(200, { dispatch_id: JOB, task: "fix_ci", owner: "acme", repo: "app", pr_number: 4, state: "pushed", outcome: "conflicts_resolved_instead", result_sha: "c".repeat(40), detail: "Cyclone resolved the conflict instead." });
  const payload = await cycloneJob(JOB, cfg);
  assert.equal(calls[0]!.url, `https://api.example.test/api/v1/agents/cyclone/jobs/${JOB}`);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(payload.summary, "Cyclone fix_ci on acme/app#4: pushed (conflicts_resolved_instead). pushed cccccccccc. Cyclone resolved the conflict instead.");
  assert.equal(cycloneJobSummary({ owner: "acme", repo: "todo", state: "queued", task: "build" }), "Cyclone build on acme/todo: queued");
});
