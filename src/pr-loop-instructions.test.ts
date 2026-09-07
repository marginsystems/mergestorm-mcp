import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_FINDING_DISMISS_MARKER,
  MCP_PR_LOOP_INSTRUCTIONS,
} from "./pr-loop-instructions.js";

test("MCP PR-loop instructions require verify, small diff, and a public dismiss", () => {
  assert.equal(MCP_FINDING_DISMISS_MARKER, "mergestorm-loop: dismiss");
  assert.match(MCP_PR_LOOP_INSTRUCTIONS, /Verify each finding/);
  assert.match(MCP_PR_LOOP_INSTRUCTIONS, /smallest correct patch/);
  assert.match(MCP_PR_LOOP_INSTRUCTIONS, /chat-only explanation is not a dismiss/);
  assert.match(MCP_PR_LOOP_INSTRUCTIONS, /mergestorm-loop: dismiss/);
  assert.match(MCP_PR_LOOP_INSTRUCTIONS, /Do not prefix that comment with cyclone-outcome:/);
});

test("MCP PR-loop instructions do not ship Cyclone's patch-agent prompt", () => {
  assert.doesNotMatch(MCP_PR_LOOP_INSTRUCTIONS, /You are Cyclone/i);
  assert.doesNotMatch(MCP_PR_LOOP_INSTRUCTIONS, /Deepseek|Grok|batchKey/i);
  assert.doesNotMatch(MCP_PR_LOOP_INSTRUCTIONS, /cyclone-outcome: dismiss/);
});
