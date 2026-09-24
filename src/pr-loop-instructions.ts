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

/** Stack-watch contract facts; patch workflow policy belongs in the skill. */
export const MCP_STACK_WATCH_INSTRUCTIONS = [
  "Stack-watch facts (mergestorm.stack_watch/v1):",
  "- waiting with nonempty issues[] is not idle; in_progress can also carry issues[].",
  "- assessment unavailable does not mean issue-free. timeout_s: 0 reads one enrich and one queue snapshot.",
  "- Restack clean does not mean mergeable or CI-green.",
  "- attention names the blocked PR via prNumber/headSha; currentCandidate is the promote candidate. Attention is not a mutation or authorization to change policy.",
  "- verifyHeadSha is a queue verification SHA, not the live PR head.",
  "- mg-park-* is a frozen GitHub base, not a repair target: never merge or rebase onto mg-park-*.",
  "- Use the mergestorm-bounce-watch skill for the fix-then-watch policy.",
].join("\n");
