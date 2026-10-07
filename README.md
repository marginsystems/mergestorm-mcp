# mergestorm-mcp

Stdio MCP server for Mergestorm. Tools: `whoami`, `credits`, `review_list`, `review_submit`, `review_wait`, `review_wait_pr`, `review_dismiss`, `stack_adopt`, `stack_list`, `stack_set`, `stack_status`, `stack_wait`, `queue_status`, `settings_get`, `settings_set`.

Every tool declares MCP `annotations` for read-only access, destructive changes, idempotence, and external systems. Reads are read-only; submission, adoption, dismissal, and policy changes are writes. Tools that can change existing policy, topology, or review gates are marked potentially destructive even when some inputs only preview or read. Annotations describe effects; the client still controls approval and authorization.

`review_wait({ job_id, timeout_s? })` reads a local review job by the `job_id` that `review_submit` returned. `review_wait_pr({ owner, repo, pr_number, after_sha?, pass?, after_pass?, timeout_s? })` reads the Vortex pass on a GitHub PR. Both poll one 45s slice by default; `timeout_s: 0` reads once without polling.

`review_dismiss({ owner, repo, pr_number, head_sha, review_id, finding_ids?, scope?, reason?, evidence_url?, preview? })` records an audited dismissal of Vortex findings the agent verified are wrong. The rules:

- **Exact identity.** `head_sha` is the PR's live head and `review_id` is a Vortex review (Core or seam) made at that head. `finding_ids` are that review's GitHub review comment ids (`offdiff-<n>` for a finding listed only in the review body, `review` for a body-only review). `scope: "review"` with no `finding_ids` covers every finding of the review.
- **Preview first.** `preview: true` lists the review's finding ids and the seam gate, and writes nothing.
- **Authorization.** The API key's account must monitor the repository or own the PR's stack, and its linked GitHub account needs write access to the repository.
- **Refusals.** A moved head (`stale_head`), another review (`review_mismatch`, `review_not_found`), an id outside that review (`unknown_finding`), a thin `reason` (`invalid_input`) or a missing permission (`forbidden`) is refused, and nothing is written.
- **Audit and retries.** Each finding is stored with the actor's GitHub login, the reason, `evidence_url`, the scope and the time. A retry reports the earlier record under `already_dismissed`.
- **Gates.** `gate.seam.cleared` is true only when every finding of that integration review is dismissed and it is still the member's current seam verdict. `gate.vortex.cleared` is true once every Vortex Blocker (error finding) at the live head is dismissed (every Core review merged into that head) and no Vortex review of the head is running or incomplete; with a warning still open the head reads `comment`, which Auto land accepts; otherwise `gate.vortex.reason` and `message` say what still holds it: that head's Vortex verdict becomes approve for Auto land, the stack watch, the dashboard and Cyclone. A partial dismissal clears nothing. CI and Auto land policy are unchanged (`gate.other_gates: "unchanged"`). For a stack PR the result carries `watch` with the next `stack_wait` call.
- **No resurfacing.** Vortex does not raise a dismissed finding again on the same diff: the same head, or a restack whose diff is unchanged.

The stack tools expose reads plus one scoped policy write:

- `stack_adopt({ owner, repo, pr_number, auto_land?, auto_review?, auto_patch?, auto_resolve_conflicts?, auto_fix_ci? })` adopts an open PR chain with optional per-stack policy. Omitted policy does not force Cyclone off. `auto_review`, `auto_patch`, `auto_resolve_conflicts`, and `auto_fix_ci` accept `true`, `false`, or `null`; `null` clears the override. Read `stack_status` with the returned `result.stack.id` to verify policy and Cyclone ownership. Adoption needs the Mergestorm Surge GitHub App on the repository (Cyclone is the auto-patch App). A refusal keeps the code `cyclone_not_connected` or `cyclone_not_installed`; its message, and `error.reason` starting with `surge_` when Surge is the one to install, say which App is missing.
- `stack_list` returns the current API key owner's registered stacks.
- `stack_set({ stack_id, auto_land?, auto_review?, auto_patch?, auto_resolve_conflicts?, auto_fix_ci? })` sets per-stack policy on one owned stack. `auto_land` flips Auto land. `auto_review`, `auto_patch`, `auto_resolve_conflicts`, and `auto_fix_ci` pin Vortex auto-review, Cyclone auto-patch, Auto-resolve merge conflicts, or Auto-fix failing CI for that stack in either direction (`true` or `false`); `null` clears the pin so the stack follows the account setting. Pass at least one key. Account settings are never changed here.
- `stack_status({ stack_id })` returns one owned stack with enriched checks and agent state, plus `attention`, `issues`, and `currentCandidate` from the same blocker rules as `stack_wait`, read against that stack's own merge queue. It returns a structured `stack_not_found` or `rate_limited` error.
- `stack_wait({ stack_id, timeout_s?, enrolled_head_sha?, after_finished_at?, bounce_id? })` waits for a stack or queue state change and returns the latest snapshots. `timeout_s: 0` returns one snapshot; a positive timeout after a snapshot with no attention returns the current `waiting` or `in_progress` status with selectors to use for the next call. An unread deadline returns `failed`. While Cyclone or Vortex is still working on the blocked PR, `stack_wait` and `stack_status` return `in_progress` instead of `attention`, with `busy[]` naming the PR, blocker, and agent, and `agents` carrying that PR's `vortexStatus`, `cycloneStatus`, `vortexReview`, and busy flags. A nonempty `busy[]` means wait. A queued Vortex run holds for at most 15 minutes, `seam_pending` alone does not hold, and reviewing or patching holds until the run finishes or its lease or check run is cleared. A blocker no agent run clears (a merge conflict vs the live parent, a restack `Conflict` or `Restack failed`, a Draft PR, a seam review pending with no review running, "Seam review stuck in reviewing, no review running", "Seam re-review pending, no review running", "Seam verdict is for an older head, no review running", or a review skipped for review quota) is still named during that `in_progress`, in `blocker`, `prNumber`, `headSha`, and `issues[]`, with `actAfter: "agents_idle"` and `waitingOn` listing the busy agents; act when a snapshot after the agents finish returns `attention`, re-reading the blocker then. For the three stuck-seam blockers, `repair` has kind `seam_review_stuck`: do not patch or push; tell the human to click Continue, which re-queues the seam review at the live head. `repair` is included when another concrete repair hint is available. Blockers the agents can change keep `blocker` and `actAfter` null. If a hold looks stuck, refresh `stack_status` and tell the human.

The background CLI watcher is optional. It monitors Mergestorm without model calls, but does not itself resume an agent conversation. Hand waiting to `mg stack watch <stack-id>` only after the host has confirmed a notification that resumes the task on completion or output matching `MS-WATCH (ATTENTION|LANDED)`. Without that facility, use bounded `stack_wait` calls with `watch.next.args`, or tell the user automatic follow-up is unavailable. A shell session ID is not proof of a wakeup subscription.

`watch.next.background` is the monitoring command, not a registered notification. Keep the latest cursor across `stack_wait` calls and reconnects. Cancellation stops the current wait, not the remote stack. After a host notification, read `stack_status` once and follow the returned repair and ownership rules.

The watcher exits on attention (exit 3), a failed read that failed again on retry (exit 3), a closed, archived, or missing stack (exit 3), or a confirmed landing (exit 0). Verify missing stacks before reporting a landing. The stack is still not done until it lands. Do not subscribe to GitHub events to wait on a stack.

Auth is `MERGESTORM_API_KEY`, then `~/.mergestorm/config.json` (same as `mg`).

`context_files` passed to `review_submit` may only read files under the host-configured sandbox root (`MERGESTORM_SANDBOX_ROOT`, default: the MCP server's working directory), so a prompt-injected agent cannot use them to exfiltrate files outside it.

## Client setup

Requires Node.js 22+ and a Mergestorm API key. Run `mg login` on the machine running the MCP server, or supply `MERGESTORM_API_KEY` through the host's environment. The stdio server uses that credential; it does not provide an OAuth endpoint. Remote hosts need their own configuration and access to any reviewed checkout.

### Codex

```bash
codex mcp add mergestorm -- npx -y mergestorm-mcp
```

For explicit configuration in `~/.codex/config.toml` (replace the checkout path):

```toml
[mcp_servers.mergestorm]
command = "npx"
args = ["-y", "mergestorm-mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 60

[mcp_servers.mergestorm.env]
MERGESTORM_SANDBOX_ROOT = "/absolute/path/to/checkout"
```

The server reads the login saved by `mg login`. If using an environment key instead, pass it with `env_vars = ["MERGESTORM_API_KEY"]` in the server table. Approval remains controlled by the host; annotations do not authorize a write. [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### Claude Code

```bash
claude mcp add --transport stdio mergestorm -- npx -y mergestorm-mcp
```

Launch with `MERGESTORM_SANDBOX_ROOT` set to the checkout when local file context is needed. [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

### Cursor

Add to project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mergestorm": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mergestorm-mcp"],
      "env": {
        "MERGESTORM_SANDBOX_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

For global `~/.cursor/mcp.json`, use an explicit sandbox path. Authentication uses the saved `mg login` on the server machine. [Cursor MCP configuration](https://cursor.com/docs/mcp).

### Connection and watch checks

In each client, confirm the server connects and lists tools, then call `whoami`. It should return the account key prefix without exposing the full key. On a known owned stack, `stack_wait` with `timeout_s: 0` should return one snapshot; use `watch.next.args` for the next bounded wait. Default waits use 45-second slices, so leave the host tool timeout above 45 seconds.

Standard stdio calls are portable; task wakeups are host features. Claude Code supports background notifications in some session modes, while availability in Codex or Cursor depends on the host and execution mode. Confirm the actual notification facility before claiming automatic continuation. This server does not advertise Claude channels or install a Codex automation or Cursor extension. After reconnecting, reuse the last returned cursor; if it was lost, take a fresh snapshot rather than claiming unseen events were handled.

Tests exercise the SDK protocol, not the UI or notification delivery of all three apps. Client configuration and the host's ability to resume the task should be checked in that client.

## Results and errors

Successful results retain their existing fields in `structuredContent`, including meaningful `null` values. The same data is serialized as a text block after the human summary for clients that consume only text content. Shared workflow policy stays in server initialization instructions; stack tools include a short reminder to follow the returned watch cursor.

Failures retain `isError: true` and a readable message. `structuredContent.error` includes the original message and, when supplied by the CLI error, `code`, `reason`, `exit_code`, and `retry_after_seconds`. Missing retry metadata does not authorize repeating a write; inspect the relevant state first. The server does not manufacture request IDs or label arbitrary transport failures safe to retry.
