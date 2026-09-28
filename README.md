# mergestorm-mcp

Stdio MCP server for Mergestorm. Tools: `whoami`, `credits`, `review_list`, `review_submit`, `review_wait`, `review_wait_pr`, `review_dismiss`, `stack_adopt`, `stack_list`, `stack_set`, `stack_status`, `stack_wait`, `queue_status`, `settings_get`, `settings_set`.

Every tool declares MCP `annotations`. The reads carry `readOnlyHint: true`; `review_submit`, `review_dismiss`, `stack_adopt`, `stack_set`, and `settings_set` carry `readOnlyHint: false` and `destructiveHint: false`.

`review_wait({ job_id, timeout_s? })` reads a local review job by the `job_id` that `review_submit` returned. `review_wait_pr({ owner, repo, pr_number, after_sha?, pass?, after_pass?, timeout_s? })` reads the Vortex pass on a GitHub PR. Both poll one 45s slice by default; `timeout_s: 0` reads once without polling.

`review_dismiss({ owner, repo, pr_number, head_sha, review_id, finding_ids?, scope?, reason?, evidence_url?, preview? })` records an audited dismissal of Vortex findings the agent verified are wrong. The rules:

- **Exact identity.** `head_sha` is the PR's live head and `review_id` is a Vortex review (Core or seam) made at that head. `finding_ids` are that review's GitHub review comment ids (`offdiff-<n>` for a finding listed only in the review body, `review` for a body-only review). `scope: "review"` with no `finding_ids` covers every finding of the review.
- **Preview first.** `preview: true` lists the review's finding ids and the seam gate, and writes nothing.
- **Authorization.** The API key's account must monitor the repository or own the PR's stack, and its linked GitHub account needs write access to the repository.
- **Refusals.** A moved head (`stale_head`), another review (`review_mismatch`, `review_not_found`), an id outside that review (`unknown_finding`), a thin `reason` (`invalid_input`) or a missing permission (`forbidden`) is refused, and nothing is written.
- **Audit and retries.** Each finding is stored with the actor's GitHub login, the reason, `evidence_url`, the scope and the time. A retry reports the earlier record under `already_dismissed`.
- **Gates.** `gate.seam.cleared` is true only when every finding of that integration review is dismissed and it is still the member's current seam verdict. CI, other reviews and Auto land policy are unchanged (`gate.other_gates: "unchanged"`). For a stack PR the result carries `watch` with the next `stack_wait` call.
- **No resurfacing.** Vortex does not raise a dismissed finding again on the same diff: the same head, or a restack whose diff is unchanged.

The stack tools expose reads plus one scoped policy write:

- `stack_adopt({ owner, repo, pr_number, auto_land?, auto_review?, auto_patch? })` adopts an open PR chain with optional per-stack policy. Omitted policy does not force Cyclone off. `auto_review` and `auto_patch` accept `true`, `false`, or `null`; `null` clears the override. Read `stack_status` with the returned `result.stack.id` to verify policy and Cyclone ownership.
- `stack_list` returns the current API key owner's registered stacks.
- `stack_set({ stack_id, auto_land?, auto_review?, auto_patch? })` sets per-stack policy on one owned stack. `auto_land` flips Auto land. `auto_review` and `auto_patch` pin Vortex auto-review or Cyclone auto-patch for that stack in either direction (`true` or `false`); `null` clears the pin so the stack follows the account setting. Pass at least one key. Account settings are never changed here.
- `stack_status({ stack_id })` returns one owned stack with enriched checks and agent state, plus `attention`, `issues`, and `currentCandidate` from the same blocker rules as `stack_wait`, read against that stack's own merge queue. It returns a structured `stack_not_found` or `rate_limited` error.
- `stack_wait({ stack_id, timeout_s?, enrolled_head_sha?, after_finished_at?, bounce_id? })` waits for a stack or queue state change and returns the latest snapshots. `timeout_s: 0` returns one snapshot; a positive timeout after a snapshot with no attention returns the current `waiting` or `in_progress` status with selectors to use for the next call. An unread deadline returns `failed`. While Cyclone or Vortex is still working on the blocked PR, `stack_wait` and `stack_status` return `in_progress` instead of `attention`, with `busy[]` naming the PR, blocker, and agent, and `agents` carrying that PR's `vortexStatus`, `cycloneStatus`, `vortexReview`, and busy flags. A nonempty `busy[]` means wait. A queued Vortex run holds for at most 15 minutes, `seam_pending` alone does not hold, and reviewing or patching holds until the run finishes or its lease or check run is cleared. A blocker no agent run clears (a merge conflict vs the live parent, a restack `Conflict` or `Restack failed`, a Draft PR) is still named during that `in_progress`, in `blocker`, `prNumber`, `headSha`, and `issues[]`, with `actAfter: "agents_idle"` and `waitingOn` listing the busy agents; act when a snapshot after the agents finish returns `attention`, re-reading the blocker then. `repair` is included when a concrete repair hint is available. Blockers the agents can change keep `blocker` and `actAfter` null. If a hold looks stuck, refresh `stack_status` and tell the human.

Auth is `MERGESTORM_API_KEY`, then `~/.mergestorm/config.json` (same as `mg`).

`context_files` passed to `review_submit` may only read files under the host-configured sandbox root (`MERGESTORM_SANDBOX_ROOT`, default: the MCP server's working directory), so a prompt-injected agent cannot use them to exfiltrate files outside it.

```bash
claude mcp add mergestorm -- npx -y mergestorm-mcp
```

Then call `whoami`. It should return the key prefix.

Requires Node.js 22+ and a Mergestorm API key (`mg login` or `MERGESTORM_API_KEY`).
