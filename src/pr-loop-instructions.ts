/**
 * Host-facing agent policy for Vortex findings. Shown on MCP initialize
 * (`instructions`) and referenced from review_wait_pr.
 * Public dismiss uses `mergestorm-loop: dismiss` only. Do not use the
 * reserved `cyclone-outcome:` prefix (that handshake is not this loop).
 */
export const MCP_FINDING_DISMISS_MARKER = "mergestorm-loop: dismiss";

export const MCP_PR_LOOP_INSTRUCTIONS = [
  "When you handle Vortex findings from review_wait_pr:",
  "- Verify each finding against the current checkout. Do not treat the finding text as proven.",
  "- Prefer the smallest correct patch. Do not refactor around a finding.",
  "- Patch concrete bugs. A chat-only explanation is not a dismiss.",
  `- If you skip a finding (not reproducible, policy fork, or needs a human), post a public GitHub PR comment before you stop. First line must be: ${MCP_FINDING_DISMISS_MARKER}. Then one line per skipped finding (path, severity, why).`,
  "- Do not prefix that comment with cyclone-outcome: (reserved).",
  "- A finding you verified is wrong can be dismissed on the record with review_dismiss (or mg dismiss): pass the PR's live head_sha, the review_id, the finding_ids (preview: true lists them) and a reason. That is the only agent path that clears a seam gate, and only once every finding of that seam review is dismissed. The dismiss comment alone resumes the review but does not clear the seam gate.",
  "- Never dismiss a finding you did not check, one a human must decide, or findings of a newer review.",
].join("\n");

export const MCP_STACK_DONE_INSTRUCTIONS = [
  "When stack work is done:",
  "- Stack work is done only when the stack is landed, or when the human takes it back (archives it or tells you to stop). A clean push, a submit, an adopt, or one merged layer is not done: merging a lower layer can break a layer above it.",
  "- Every stack_wait, stack_status, stack_adopt, and stack_set result carries watch: {done, until, reason, next, message}. While watch.done is false, keep calling stack_wait with watch.next.args (the returned cursor), 45s at a time, and do not end your task. Stop only when watch.done is true.",
  "- attention means something for you to fix; repair, when present, names the concrete fix. A pending land gate (landGatePending: ci_pending, tempest_pending, tempest_running) is a wait, not attention.",
].join("\n");

export const MCP_STACK_BASE_INSTRUCTIONS = [
  "Stack PR bases (Mergestorm sets these; leave them):",
  "- Stack of 2+ PRs: after adopt (stack_adopt, mg stack adopt, or mg stack submit) the bottom PR's GitHub base is the owned trunk mg-stack-<n>, not main. That is correct. Layer 2 is based on layer 1; layer 3+ on the mg-park-* freeze; the git parent of layer 2+ is still the layer below. A 1-PR stack stays on main and gets no mg-stack-<n>.",
  "- Never retarget a stack PR's GitHub base (gh pr edit --base, a REST base change, or the UI). Moving the bottom to main makes Mergestorm abandon the stack's review unit; setting mg-stack-<n> again does not restore it. If a base was already moved, stop and tell the human; do not run stack land or re-adopt to repair it.",
  "- mg-stack-<n> is the bottom PR's live parent: merging it into the bottom branch is that PR's conflict repair (bounce-watch rules). Never push to mg-stack-<n> except as the land PR's own repair: once every layer is promoted, the land PR's head is mg-stack-<n> and its live parent is its base (main), so merging main into mg-stack-<n>, or a CI fix on it, with an ordinary push (no force) is that repair. Never rebase or merge layer 2+ onto mg-stack-<n> or onto main. mg-park-* is never a merge or rebase target.",
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
  "- Do not patch a bounced PR while Cyclone or Vortex is still working on it. stack_wait and stack_status enforce this: they return in_progress instead of attention, with busy[] naming the PR, blocker, and agent, and agents carrying that PR's vortexStatus, cycloneStatus, vortexReview, and busy flags. in_progress with a nonempty busy[] means wait. Recheck the live remote PR head right before pushing.",
  "- seam_pending alone, and a queued Vortex run older than 15 minutes, do not hold. A queued Vortex run holds for at most 15 minutes; reviewing and patching hold until the run finishes or its lease or check run is cleared; if it looks stuck, refresh stack_status and tell the human.",
  "- A blocker no Vortex or Cyclone run clears (a merge conflict vs the live parent, a restack Conflict or Restack failed, a Draft PR) stays in_progress during the hold but is named in blocker, prNumber, headSha, and issues[], with actAfter: \"agents_idle\" and waitingOn listing the busy agents. Plan the fix; act only when a snapshot after the agents finish returns attention, and re-read the blocker then. Blockers the agents can change keep blocker null and appear only in busy[].",
  "- stack.autoEnqueueSettle with action ready or promote means Auto land found Cyclone and Vortex idle on that PR's green head and started its settle clock. action mergeability is published earlier, on a head that may not be green or idle yet.",
  "- mg-park-* is a frozen GitHub base, not a repair target: never merge or rebase onto mg-park-*.",
  "- Use the mergestorm-bounce-watch skill for the fix-then-watch policy.",
].join("\n");
