import assert from "node:assert/strict";
import { test } from "node:test";
import { StackWatchError, StackWatchTimeoutError, type StackWatchEnvelope } from "mergestorm/client";
import { stackWait } from "./stack-wait.js";

const envelope: StackWatchEnvelope = {
  issues: [], currentCandidate: null, assessment: "available",
  schema: "mergestorm.stack_watch/v1", status: "attention", stackId: "stack-1",
  blocker: "Conflict", bounceKind: null, prNumber: 12, headSha: "new-head",
  cursor: { stackId: "stack-1", enrolledHeadSha: "old-head" },
};

test("stack_wait passes cursor values unchanged and returns the poller envelope", async () => {
  const controller = new AbortController();
  const result = await stackWait({
    stack_id: "stack-1", timeout_s: 45,
    enrolled_head_sha: " ABC123 ", after_finished_at: "2026-09-19T10:00:00+07:00", bounce_id: "bounce-1",
  }, {}, { signal: controller.signal, pollStackWatch: async (_cfg, id, opts) => {
    assert.equal(id, "stack-1");
    assert.equal(opts?.timeoutMs, 45_000);
    assert.equal(opts?.signal, controller.signal);
    assert.deepEqual(opts?.cursor, {
      stackId: "stack-1", enrolledHeadSha: " ABC123 ", afterFinishedAt: "2026-09-19T10:00:00+07:00",
      bounceId: "bounce-1",
    });
    return envelope;
  } });
  assert.deepEqual(result.data, envelope);
  assert.equal(result.summary, "Stack stack-1 · attention · blocked: #12 Conflict");
  assert.notEqual(result.isError, true);
});

test("stack_wait defaults to 45 seconds and lets the poller enroll a fresh cursor", async () => {
  await stackWait({ stack_id: "stack-1" }, {}, { pollStackWatch: async (_cfg, _id, opts) => {
    assert.equal(opts?.timeoutMs, 45_000);
    assert.equal(opts?.cursor, undefined);
    return envelope;
  } });
});

test("stack_wait timeout returns waiting, preserving the last cursor", async () => {
  const last = { ...envelope, status: "waiting" as const, blocker: null };
  const result = await stackWait({ stack_id: "stack-1" }, {}, {
    pollStackWatch: async () => { throw new StackWatchTimeoutError(last); },
  });
  assert.deepEqual(result.data, last);
  assert.equal(
    result.summary,
    "Stack stack-1 · waiting · watch not finished: call stack_wait again with timeout_s 45 and the same cursor: stack_id \"stack-1\", enrolled_head_sha \"old-head\"",
  );
  assert.notEqual(result.isError, true);
});

test("stack_wait in_progress summary keeps blockers and prints explicit null selectors", async () => {
  const result = await stackWait({ stack_id: "stack-1", timeout_s: 0 }, {}, {
    pollStackWatch: async () => ({
      ...envelope,
      status: "in_progress",
      assessment: "unavailable",
      blocker: null,
      prNumber: null,
      issues: [{ prNumber: 13, headSha: null, blocker: "CI failed", bounceKind: null }],
      cursor: { stackId: "stack-1", enrolledHeadSha: null, afterFinishedAt: null, bounceId: "bounce-1" },
    }),
  });
  assert.equal(
    result.summary,
    "Stack stack-1 · in_progress · issues: #13 CI failed · assessment unavailable · watch not finished: call stack_wait again with timeout_s 45 and the same cursor: stack_id \"stack-1\", enrolled_head_sha null, after_finished_at null, bounce_id \"bounce-1\"",
  );
});

test("stack_wait summary includes issues and unavailable assessment", async () => {
  const result = await stackWait({ stack_id: "stack-1", timeout_s: 0 }, {}, {
    pollStackWatch: async () => ({
      ...envelope,
      assessment: "unavailable",
      blocker: null,
      prNumber: null,
      issues: [{ prNumber: 13, headSha: null, blocker: "CI failed", bounceKind: null }],
    }),
  });
  assert.equal(result.summary, "Stack stack-1 · attention · issues: #13 CI failed · assessment unavailable");
});

test("stack_wait returns poll errors as structured status data", async () => {
  const last = {
    ...envelope,
    status: "failed" as const,
    assessment: "unavailable" as const,
    issues: [{ prNumber: 13, headSha: null, blocker: "CI failed", bounceKind: null }],
  };
  const result = await stackWait({ stack_id: "stack-1" }, {}, {
    pollStackWatch: async () => { throw new StackWatchError("Stack poll failed (HTTP 429)", last, undefined, 9); },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.data, { ...last, retry_after_seconds: 9 });
  assert.equal(result.summary, "Stack stack-1 · failed · blocked: #12 Conflict · issues: #13 CI failed · assessment unavailable");
});

test("stack_wait rejects invalid timeout and missing id before polling", async () => {
  let polled = 0;
  for (const input of [{ stack_id: "" }, ...[-1, 46, 301, NaN, Infinity].map(timeout_s => ({ stack_id: "stack-1", timeout_s }))]) {
    await assert.rejects(() => stackWait(input, {}, {
      pollStackWatch: async () => { polled++; return envelope; },
    }));
    assert.equal(polled, 0);
  }
});

test("stack_wait only reads stack and queue snapshots", async (t) => {
  const requests: string[] = [];
  const queueUrls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    const url = new URL(String(input));
    const route = url.pathname;
    if (route.endsWith("/queue")) queueUrls.push(url);
    requests.push(route);
    return Response.json(route.endsWith("/queue") ? { entries: [] } : {
      stacks: [{ id: "stack-1", layers: [] }],
    });
  });
  const result = await stackWait({ stack_id: "stack-1", timeout_s: 1, enrolled_head_sha: "old-head", after_finished_at: "original" }, {
    apiKey: "test", apiBase: "https://api.example.test",
  });
  assert.deepEqual(requests.slice(0, 4), [
    "/api/v1/stacks/enrich", "/api/v1/stacks/queue", "/api/v1/stacks/queue", "/api/v1/stacks/enrich",
  ]);
  assert.equal(queueUrls[1]?.searchParams.get("wait"), "1");
  assert.equal(result.data.status, "waiting");
  assert.deepEqual(result.data.cursor, { stackId: "stack-1", enrolledHeadSha: "old-head", afterFinishedAt: "original" });
});
