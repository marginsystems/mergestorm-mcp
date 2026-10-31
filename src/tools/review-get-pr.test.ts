import assert from "node:assert/strict";
import { afterEach,describe,test } from "node:test";
import { prReviewSummary } from "./review-get-pr.js";

describe("review-pr", { concurrency: false }, () => {

  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  });

  test("prReviewSummary includes sha, finding count, and phase for the host", () => {
    assert.equal(
      prReviewSummary("acme", "widgets", 12, {
        status: "completed",
        head_sha: "abc123def456",
        finding_count: 1,
        phase: null,
      }),
      "acme/widgets#12 · completed · sha abc123d · 1 finding",
    );
    assert.equal(
      prReviewSummary("acme", "widgets", 12, {
        status: "in_progress",
        head_sha: "abc123def456",
        finding_count: 0,
        phase: "synthesizing",
      }),
      "acme/widgets#12 · in_progress · sha abc123d · 0 findings · synthesizing",
    );
  });
});
