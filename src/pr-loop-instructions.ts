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
  "- Every stack_wait, stack_status, stack_adopt, and stack_set result carries watch: {done, until, reason, next, message}. While watch.done is false, keep calling stack_wait with watch.next.args (the returned cursor), 45s at a time, or hand the waiting to the background watcher below, and do not end your task. Stop only when watch.done is true.",
  "- If your host cannot hold a long turn open (Cursor, Claude Code, Codex, and other turn-based agents), do not poll stack_wait inside your turn: run `mg stack watch <stack-id>` as a background command with a notification on output matching `MS-WATCH (ATTENTION|LANDED)`, then end your turn. The watcher runs stack_wait against the Mergestorm API in slices of at most 300s, carries the cursor, stays silent while the stack is waiting or in_progress (busy[] holds and actAfter included), and costs no model tokens. It exits on attention (`MS-WATCH ATTENTION pr=<n> head=<sha> blocker=... repair=<kind>`, exit 3), on a read that failed twice (`MS-WATCH ATTENTION failed`, exit 3; tell the human the stack is no longer watched), or when watch.done is true (`MS-WATCH LANDED stack=<id> reason=<reason>`, exit 0; only reason=landed is landed). On an attention wake, read stack_status once, fix the blocker per mergestorm-bounce-watch, push, and start `mg stack watch <stack-id> --head <pushed-sha>` again. Ending your turn while the watcher runs is not ending the task. Do not subscribe to GitHub events to wait on a stack.",
  "- A layer PR shown as merged is merged into mg-stack-<n>, not main. The stack is landed only when the land PR (head mg-stack-<n>) merges into main or watch.done says landed. Never judge landing from GitHub PR state alone.",
  "- attention means something for you to fix; repair, when present, names the concrete fix. A pending land gate (landGatePending: ci_pending, tempest_pending, tempest_running) is a wait, not attention.",
].join("\n");

export const MCP_STACK_BASE_INSTRUCTIONS = [
  "Stack PR bases (Mergestorm sets these; leave them):",
  "- Stack of 2+ PRs: after adopt (stack_adopt, mg stack adopt, or mg stack submit) the bottom PR's GitHub base is the owned trunk mg-stack-<n>, not main. That is correct. Layer 2 is based on layer 1; layer 3+ on the mg-park-* freeze; the git parent of layer 2+ is still the layer below. A 1-PR stack stays on main and gets no mg-stack-<n>.",
  "- Never retarget a stack PR's GitHub base (gh pr edit --base, a REST base change, or the UI). Moving the bottom to main makes Mergestorm abandon the stack's review unit; setting mg-stack-<n> again does not restore it. If a base was already moved, stop and tell the human; do not run stack land or re-adopt to repair it.",
  "- mg-stack-<n> is the bottom PR's live parent: merging it into the bottom branch is that PR's conflict repair (bounce-watch rules). Never push to mg-stack-<n> except as the land PR's own repair: once every layer is promoted, the land PR's head is mg-stack-<n> and its live parent is its base (main), so merging main into mg-stack-<n>, a CI fix on it, or a fix for tempest_findings on it, with an ordinary push (no force) is that repair. Fix tempest_findings only when busy[] shows no Cyclone run on the land PR, and verify each finding first, as for Vortex findings. Never rebase or merge layer 2+ onto mg-stack-<n> or onto main. mg-park-* is never a merge or rebase target.",
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
  "- A blocker no Vortex or Cyclone run clears (a merge conflict vs the live parent, a restack Conflict or Restack failed, a Draft PR, a seam review pending with no review running, \"Seam review stuck in reviewing, no review running\", \"Seam re-review pending, no review running\", \"Seam verdict is for an older head, no review running\", or a review skipped for review quota) stays in_progress during the hold but is named in blocker, prNumber, headSha, and issues[], with actAfter: \"agents_idle\" and waitingOn listing the busy agents. Plan the fix; act only when a snapshot after the agents finish returns attention, and re-read the blocker then. Blockers the agents can change keep blocker null and appear only in busy[]. For the three stuck-seam blockers, repair kind seam_review_stuck: do not patch or push; tell the human to click Continue, which re-queues the seam review at the live head.",
  "- stack.autoEnqueueSettle with action ready or promote means Auto land found Cyclone and Vortex idle on that PR's green head and started its settle clock. action mergeability is published earlier, on a head that may not be green or idle yet.",
  "- mg-park-* is a frozen GitHub base, not a repair target: never merge or rebase onto mg-park-*.",
  "- merge_failed, gh_error, and ci_timeout bounces turn Auto land off, and stack autoLandOff then reads reason bounced with that queue entry's id; any other autoLandOff reason (user, archive, watcher, cancelled, landed) is not a bounce to undo. The watching agent turns Auto land back on with stack_set auto_land: true once it has handled that bounce, at most once per bounce and 3 times per watch; mergestorm-bounce-watch has the conditions.",
  "- While stack autoLandOff reads reason bounced, the watch returns attention: blocker \"Auto land off after <kind> bounce\", the bounce in issues[], repair kind auto_land_off.",
  "- A stack whose review unit was abandoned (a human moved its bottom PR off mg-stack-N) returns attention: blocker \"Review unit abandoned: based on <base>\", repair kind unit_abandoned. Do not patch or retarget; ask the human whether to re-root it. If at least two PRs remain open, tell them that mg stack adopt owner/repo#<bottom PR> re-roots it on a new review unit. With only one open PR, re-adopting will not create a review unit, so tell them to close and resubmit it to create a fresh stack.",
  "- Auto land records why it is waiting (stack autoLandWait: reason, prNumber, headSha, since). The watch returns attention on that PR when the wait cannot clear on its own: a failing check Auto land reads live on GitHub, even while the ledger shows CI green (blocker \"CI failed — Auto land reads a failing check on GitHub at this head\", repair kind ci_failure); a check pending for 45 minutes (repair kind ci_pending); no approving Vortex review for 30 minutes with no Vortex run working (repair kind vortex_not_green); and a promote GitHub refused 3 times with merge_failed, after which Auto land stops retrying that head (repair kind promote_failed). A more specific blocker on that PR is named first. A new head clears the wait.",
  "- While the stack has a live merge queue entry, stack_wait carries queueWait (the entry's wait reason, how long it has been held, and the stack queued ahead of it) and the status line names it. The watch returns attention, blocker \"Merge queue stuck: ...\" and repair kind queue_stalled, when the entry (or the entry ahead of it) has been held for 45 minutes without landing or bouncing.",
  "- When no Vortex run works on the head and its review was skipped because auto-review is off (blocker \"Vortex auto-review is off, so this head was not reviewed\") or because billing could not be confirmed (\"Vortex skipped this head: it could not confirm billing\"), or it covered only part of the PR (\"Vortex reviewed only part of this PR\"), the watch returns attention at once with repair kind vortex_skipped. Do not patch for it; the repair names the mention or setting that gets the head reviewed.",
  "- A live-head Vortex request_changes handoff returns attention with blocker \"Vortex findings need a person\" and repair kind vortex_findings; verify the review and inline findings against the live head before repair.",
  "- Tempest never patches. Cyclone patches a land PR when auto-patch is on for that stack (its override, else the account setting); otherwise the watching agent fixes tempest_findings on the land PR, and repair kind tempest_findings names it. A Tempest run that breaks without a result is re-run by Mergestorm at the same head a few times; after that the land gate reads tempest_failed with repair kind tempest_rerun: there is nothing to patch, so re-run Tempest with the comment the repair names. tempest_stopped (a person stopped the review) also carries repair kind tempest_rerun: ask the human before re-running it.",
  "- Use the mergestorm-bounce-watch skill for the fix-then-watch policy.",
].join("\n");
