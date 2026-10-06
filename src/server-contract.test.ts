import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError } from "mergestorm/client";
import { fail } from "./server.js";

const failures: Array<{ name: string; thrown: unknown; error: Record<string, unknown> }> = [
  {
    name: "installation refusal",
    thrown: new CommandError("Install Mergestorm Surge.", 1, "cyclone_not_connected", { reason: "surge_not_connected" }),
    error: { code: "cyclone_not_connected", message: "Install Mergestorm Surge.", exit_code: 1, reason: "surge_not_connected" },
  },
  {
    name: "rate limit with server-provided delay",
    thrown: new CommandError("Wait for a running review.", 7, "rate_limited", { retryAfterSeconds: 9 }),
    error: { code: "rate_limited", message: "Wait for a running review.", exit_code: 7, retry_after_seconds: 9 },
  },
  {
    name: "explicit zero delay and empty reason",
    thrown: new CommandError("Busy.", 1, "busy", { retryAfterSeconds: 0, reason: "" }),
    error: { code: "busy", message: "Busy.", exit_code: 1, retry_after_seconds: 0, reason: "" },
  },
  {
    name: "timeout with uncertain write outcome",
    thrown: new CommandError("Request timed out.", 1, "api_timeout"),
    error: { code: "api_timeout", message: "Request timed out.", exit_code: 1 },
  },
  {
    name: "command failure without a code",
    thrown: new CommandError("Unavailable."),
    error: { message: "Unavailable.", exit_code: 1 },
  },
  {
    name: "unexpected error",
    thrown: new Error("Unexpected failure."),
    error: { message: "Unexpected failure." },
  },
  {
    name: "non-error throw",
    thrown: "Unknown failure.",
    error: { message: "Unknown failure." },
  },
];

for (const { name, thrown, error } of failures) {
  test(`tool failure preserves known fields for structured and text-only clients: ${name}`, () => {
    const result = fail(thrown);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { error });
    assert.deepEqual(JSON.parse(result.content[1]!.text), result.structuredContent);
    assert.ok(result.content[0]!.text.includes(String(error.message)));
    assert.equal("retryable" in result.structuredContent.error, false);
    assert.equal("request_id" in result.structuredContent.error, false);
  });
}
