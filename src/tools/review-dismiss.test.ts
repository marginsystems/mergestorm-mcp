import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { STACK_WATCH_NOT_DONE_SENTENCE, type PrFindingDismissResult } from "mergestorm/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMergestormMcpServer } from "../server.js";
import { reviewDismiss } from "./review-dismiss.js";

const HEAD = "55ec0485921e7221a3dc107055166ef4a31f7d2a";
const cfg = { apiKey: "msk_live_test_mcp_key", apiBase: "https://api.example.test" };

const result: PrFindingDismissResult = {
  status: "dismissed",
  owner: "marginsystems",
  repo: "mergestorm",
  pr_number: 2930,
  head_sha: HEAD,
  review_id: 5333776289,
  review_kind: "seam",
  scope: "findings",
  dismissed: [{ finding_id: "4118393726", finding_key: "D-0123456789ab", path: "torture/adapter.ts", line: null, title: "Driver subprocess misses TMPDIR" }],
  already_dismissed: [],
  remaining: [],
  all_dismissed: true,
  gate: { seam: { state: "approved", reviewed_sha: HEAD, review_id: 5333776289, cleared: true, blocking: false }, other_gates: "unchanged" },
  stack_id: "66352490-093e-428c-800b-ca4f447610ad",
};

let originalFetch: typeof globalThis.fetch | undefined;
afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
});

test("review_dismiss posts the exact identity and returns the gate with the next stack_wait", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.example.test/api/v1/stacks/pr-review/dismiss");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      owner: "marginsystems",
      repo: "mergestorm",
      pr_number: 2930,
      head_sha: HEAD,
      review_id: 5333776289,
      finding_ids: ["4118393726"],
      reason: "driverEnv already supplies TMPDIR to spawn",
      evidence_url: "https://github.com/acme/widgets/pull/12#issuecomment-345",
    });
    return Response.json(result);
  };
  const payload = await reviewDismiss(
    {
      owner: "marginsystems",
      repo: "mergestorm",
      pr_number: 2930,
      head_sha: HEAD,
      review_id: 5333776289,
      finding_ids: ["4118393726"],
      reason: "driverEnv already supplies TMPDIR to spawn",
      evidence_url: "https://github.com/acme/widgets/pull/12#issuecomment-345",
    },
    cfg,
  );
  assert.equal(payload.isError, undefined);
  assert.ok(payload.summary.startsWith(STACK_WATCH_NOT_DONE_SENTENCE));
  assert.match(payload.summary, /Seam gate cleared at this head/);
  const watch = payload.data.watch as { next: { tool: string; args: { stack_id: string } } };
  assert.equal(watch.next.tool, "stack_wait");
  assert.equal(watch.next.args.stack_id, result.stack_id);
});

test("review_dismiss returns a refusal as an error envelope with the server code", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ error: "stale_head", message: "PR #2930 head is 1111111, not 55ec048." }, { status: 409 });
  const payload = await reviewDismiss(
    { owner: "o", repo: "r", pr_number: 1, head_sha: HEAD, review_id: 5, scope: "review", reason: "a long enough reason here" },
    cfg,
  );
  assert.equal(payload.isError, true);
  assert.deepEqual(payload.data.error, { code: "stale_head", message: "PR #2930 head is 1111111, not 55ec048.", status: 409 });
});

test("review_dismiss preview without a stack lists findings and carries no watch", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ...result,
      status: "preview",
      dismissed: [],
      remaining: result.dismissed,
      all_dismissed: false,
      gate: { seam: null, other_gates: "unchanged" },
      stack_id: null,
    });
  const payload = await reviewDismiss(
    { owner: "o", repo: "r", pr_number: 1, head_sha: HEAD, review_id: 5, preview: true },
    cfg,
  );
  assert.match(payload.summary, /1 open finding\(s\). Nothing was written./);
  assert.match(payload.summary, /4118393726 \(torture\/adapter.ts/);
  assert.equal(payload.data.watch, undefined);
});

test("review_dismiss says when a Core review's dismissal cleared the Vortex gate", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ...result,
      review_kind: "core",
      gate: { seam: null, vortex: { cleared: true }, other_gates: "unchanged" },
      stack_id: null,
    });
  const payload = await reviewDismiss(
    { owner: "o", repo: "r", pr_number: 1, head_sha: HEAD, review_id: 5, scope: "review", reason: "every finding here was verified wrong" },
    cfg,
  );
  assert.match(payload.summary, /Vortex gate cleared at this head/);
});

test("review_dismiss says why a Core review's dismissal left the Vortex gate shut", async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ...result,
      review_kind: "core",
      gate: {
        seam: null,
        vortex: { cleared: false, reason: "coverage_incomplete", message: "Vortex has not reviewed every file at this head yet." },
        other_gates: "unchanged",
      },
      stack_id: null,
    });
  const payload = await reviewDismiss(
    { owner: "o", repo: "r", pr_number: 1, head_sha: HEAD, review_id: 5, scope: "review", reason: "every finding here was verified wrong" },
    cfg,
  );
  assert.match(payload.summary, /Vortex gate not cleared: Vortex has not reviewed every file at this head yet\./);
});

test("MCP review_dismiss rejects a short head SHA before calling the API", async () => {
  originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({});
  };
  const server = createMergestormMcpServer();
  const client = new Client({ name: "dismiss-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const out = await client.callTool({
      name: "review_dismiss",
      arguments: { owner: "o", repo: "r", pr_number: 1, head_sha: "55ec048", review_id: 5, scope: "review", reason: "x" },
    });
    assert.equal(out.isError, true);
    assert.equal(calls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
