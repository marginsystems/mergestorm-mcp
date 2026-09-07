/**
 * Host-facing agent policy for Vortex findings. Shown on MCP initialize
 * (`instructions`) and referenced from review_get_pr / review_wait_pr.
 * Public dismiss uses `mergestorm-loop: dismiss` only. Do not use the
 * reserved `cyclone-outcome:` prefix (that handshake is not this loop).
 */
export const MCP_FINDING_DISMISS_MARKER = "mergestorm-loop: dismiss";

export const MCP_PR_LOOP_INSTRUCTIONS = [
  "When you handle Vortex findings from review_get_pr or review_wait_pr:",
  "- Verify each finding against the current checkout. Do not treat the finding text as proven.",
  "- Prefer the smallest correct patch. Do not refactor around a finding.",
  "- Patch concrete bugs. A chat-only explanation is not a dismiss.",
  `- If you skip a finding (not reproducible, policy fork, or needs a human), post a public GitHub PR comment before you stop. First line must be: ${MCP_FINDING_DISMISS_MARKER}. Then one line per skipped finding (path, severity, why).`,
  "- Do not prefix that comment with cyclone-outcome: (reserved).",
].join("\n");
