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

export const MCP_STACK_BASE_INSTRUCTIONS = [
  "Stack PR bases (Mergestorm sets these; leave them):",
  "- Stack of 2+ PRs: after adopt (stack_adopt, mg stack adopt, or mg stack submit) the bottom PR's GitHub base is the owned trunk mg-stack-<n>, not main. That is correct. Layer 2 is based on layer 1; layer 3+ on the mg-park-* freeze; the git parent of layer 2+ is still the layer below. A 1-PR stack stays on main and gets no mg-stack-<n>.",
  "- Never retarget a stack PR's GitHub base (gh pr edit --base, a REST base change, or the UI). Moving the bottom to main makes Mergestorm abandon the stack's review unit; setting mg-stack-<n> again does not restore it. If a base was already moved, stop and tell the human; do not run stack land or re-adopt to repair it.",
  "- mg-stack-<n> is the bottom PR's live parent: merging it into the bottom branch is that PR's conflict repair (bounce-watch rules). Never push to mg-stack-<n>, and never rebase or merge layer 2+ onto it or onto main. mg-park-* is never a merge or rebase target.",
  "- mg stack submit prints the base each PR opened with; the bottom moves to mg-stack-<n> right after. stack_status trunkBranch is the current trunk.",
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
