# mergestorm-mcp

Stdio MCP server for Mergestorm. Tools: `whoami`, `credits`, `review_list`, `review_submit`, `review_wait`, `review_wait_pr`, `review_dismiss`, `review_start_pr`, `review_stop_pr`, `cyclone_start`, `cyclone_job`, `issue_create`, `issue_review_wait`, `stack_adopt`, `stack_enqueue`, `stack_list`, `stack_publish`, `stack_publish_status`, `stack_restack`, `stack_set`, `stack_status`, `stack_wait`, `queue_status`, `settings_get`, `settings_set`, `repo_settings_get`, `repo_settings_set`, `surge_setup`, `list_memories`, `search_memory`, `remember`, `update_memory`, `forget_memory`, `get_memory_mode`, `set_memory_mode`, `web_search`, `read_web_page`.

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

`issue_create({ title, body?, labels?, owner?, repo?, cwd? })` opens a GitHub issue through Mergestorm with no GitHub credentials: the Surge App creates it and names the caller in the body. It defaults to the origin repository of `cwd`. Labels must already exist on the repository. The same title again returns the open issue it already made (`created: false`), so a retry does not duplicate it. Then call `issue_review_wait` and open the pull request, with `Fixes #<number>` in the commit or pull request body, only once the issue is approved.

`issue_review_wait({ owner, repo, number, timeout_s? })` reads the Vortex review of an issue: `state` (`approved`, `needs_answers`, `pending`, `unreviewed`, `capped` or `off`), the round, the verdict, up to 8 points, the review comment link and `next`, one sentence saying what to do. `timeout_s: 0` reads it once; otherwise it waits while the review is pending, for up to 45s (the default), and returns `pending` when the slice ends. On `needs_answers` or `unreviewed`, answer the points in a comment on the issue and call it again; Vortex reviews each reply. On `capped`, a person approves with an issue comment whose first line is `mergestorm-issue: approve`. `stack_adopt` and `stack_publish` refuse a pull request whose linked issue is not approved with `issue_not_approved`, naming each issue's state and points.

The agent tools start work on the user's own pull requests and repositories (`POST /api/v1/agents/...`):

- `review_start_pr({ owner, repo, pr_number, head_sha? })` starts a Vortex review at the pull request's current head (one standard credit). With `head_sha`, nothing starts unless that is still the head. `review_stop_pr({ owner, repo, pr_number })` cancels a running review.
- `cyclone_start({ task, owner, repo, pr_number?, failing_check?, brief? })` has Cyclone `fix_findings`, `fix_ci` or `resolve_conflicts` on a pull request and push the result, or `build` a first version of a new project from `brief` into an empty repository. A pull request with nothing to do (CI green, no conflicts, no open findings) is refused with the reason. `cyclone_job({ dispatch_id, timeout_s? })` waits up to `timeout_s` seconds (default 45, max 100, 0 reads once) until the job is pushed, completed or failed, and returns its state, outcome, pushed commit and changed files; call it again while the job is queued or running.
- `stack_restack({ stack_id })` rebases a stack's layers onto their parents; `stack_enqueue({ stack_id })` sends it to the merge queue. Restarting a failed land is a restack, then an enqueue. Neither lands or promotes anything by itself.
- `list_memories`, `search_memory`, `remember`, `update_memory`, `forget_memory`, `get_memory_mode` and `set_memory_mode` manage what Mergestorm remembers about you, through `/api/v1/memories`. Inside a Breeze chat, `remember` and `search_memory` follow that chat's memory setting.
- `web_search` and `read_web_page` search the public web and read one page, through `/api/v1/web`, with a budget of 30 calls per key per hour.
- `surge_setup({ owner, repo })` serves a repository on Surge when it is not served yet and opens the pull request that moves its CI to Surge runners.

When the server serves a Breeze chat (`MERGESTORM_CHAT_ID`, or the hosted endpoint's chat header), `cyclone_start`, `review_start_pr`, `stack_enqueue`, and a `review_wait_pr` or `stack_wait` that times out record the work as a background task of that chat, so the chat gets the result when the work finishes.

The stack tools expose reads, one scoped policy write, and publication of your own branch:

- `stack_adopt({ owner, repo, pr_number, auto_land?, auto_review?, auto_patch?, auto_resolve_conflicts?, auto_fix_ci? })` adopts an open PR chain with optional per-stack policy. Omitted policy does not force Cyclone off. `auto_review`, `auto_patch`, `auto_resolve_conflicts`, and `auto_fix_ci` accept `true`, `false`, or `null`; `null` clears the override. Read `stack_status` with the returned `result.stack.id` to verify policy and Cyclone ownership. Adoption needs the Mergestorm Surge GitHub App on the repository (Cyclone is the auto-patch App). A refusal keeps the code `cyclone_not_connected` or `cyclone_not_installed`; its message, and `error.reason` starting with `surge_` when Surge is the one to install, say which App is missing.
- `stack_list` returns the current API key owner's registered stacks.
- `stack_publish({ cwd?, owner?, repo?, branch?, base?, extend?, title?, body?, replace_head?, auto_land? })` publishes a local branch with no GitHub credentials. It reads the branch's commits from the repository at `cwd` and sends them to Mergestorm, which writes them and the branch on GitHub as the Surge App, opens a ready pull request, and registers the stack with Auto land on for a new stack, and Auto patch and Auto review left to the stack, repository and account settings. With no `base` the branch opens as a single PR onto trunk; to stack it on another branch, pass that branch as `base` with `extend: true`. A non-trunk `base` without `extend` fails with `implicit_stack`. The summary says which one it made. It never runs `gh`, `git push` or `git fetch`. Call it again for every later commit to that branch, and after a lost response: it resumes and does not duplicate the branch, commits, pull request or stack. It refuses with `head_changed` when the branch on GitHub holds work the local branch does not; `replace_head` names the exact GitHub head to replace. Limits: 20 commits, 500 changed paths, 2 MiB a file, 8 MiB in total; no submodules or merge commits. The result carries the verified head commit and tree, the pull request, the stack and its `watch`.
- `stack_publish_status({ cwd?, owner?, repo?, branch? })` reads how far a publication got (`absent`, `pushed`, `opened`, `registered`) with the head on GitHub, the pull request and the stack's Auto patch and Auto land state. It changes nothing.
- `stack_set({ stack_id, auto_land?, auto_review?, auto_patch?, auto_resolve_conflicts?, auto_fix_ci? })` sets per-stack policy on one owned stack. `auto_land` flips Auto land. `auto_review`, `auto_patch`, `auto_resolve_conflicts`, and `auto_fix_ci` pin Vortex auto-review, Cyclone auto-patch, Auto-resolve merge conflicts, or Auto-fix failing CI for that stack in either direction (`true` or `false`); `null` clears the pin so the stack follows the account setting. Pass at least one key. Account settings are never changed here.
- `stack_status({ stack_id })` returns one owned stack with enriched checks and agent state, plus `attention`, `issues`, and `currentCandidate` from the same blocker rules as `stack_wait`, read against that stack's own merge queue. Attention covers every open layer, not only `currentCandidate`: it names the lowest layer with a blocker an agent must fix and no Vortex or Cyclone run working on it. It returns a structured `stack_not_found` or `rate_limited` error.
- `stack_wait({ stack_id, timeout_s?, enrolled_head_sha?, after_finished_at?, bounce_id? })` waits for a stack or queue state change and returns the latest snapshots. `timeout_s: 0` returns one snapshot; a positive timeout after a snapshot with no attention returns the current `waiting` or `in_progress` status with selectors to use for the next call. An unread deadline returns `failed`. While Cyclone or Vortex is still working on the blocked PR, `stack_wait` and `stack_status` return `in_progress` instead of `attention`, with `busy[]` naming the PR, blocker, and agent, and `agents` carrying that PR's `vortexStatus`, `cycloneStatus`, `vortexReview`, and busy flags. A nonempty `busy[]` means wait. When another layer has a blocker no agent works on, `attention` names that blocker instead and `busy[]` is empty. A queued Vortex run holds for at most 15 minutes, `seam_pending` alone does not hold, and reviewing or patching holds until the run finishes or its lease or check run is cleared. A blocker no agent run clears (a merge conflict vs the live parent, a restack `Conflict` or `Restack failed`, a Draft PR, a seam review pending with no review running, "Seam review stuck in reviewing, no review running", "Seam re-review pending, no review running", "Seam verdict is for an older head, no review running", or a review skipped for review quota) is still named during that `in_progress`, in `blocker`, `prNumber`, `headSha`, and `issues[]`, with `actAfter: "agents_idle"` and `waitingOn` listing the busy agents; act when a snapshot after the agents finish returns `attention`, re-reading the blocker then. For the three stuck-seam blockers, `repair` has kind `seam_review_stuck`: do not patch or push; tell the human to click Continue, which re-queues the seam review at the live head. `repair` is included when another concrete repair hint is available. Blockers the agents can change keep `blocker` and `actAfter` null. If a hold looks stuck, refresh `stack_status` and tell the human.

The background CLI watcher is optional. It monitors Mergestorm without model calls, but does not itself resume an agent conversation. Hand waiting to `mg stack watch <stack-id>` only after the host has confirmed a notification that resumes the task on completion or output matching `MS-WATCH (ATTENTION|LANDED)`. Without that facility, use bounded `stack_wait` calls with `watch.next.args`, or tell the user automatic follow-up is unavailable. A shell session ID is not proof of a wakeup subscription.

`watch.next.background` is the monitoring command, not a registered notification. Keep the latest cursor across `stack_wait` calls and reconnects. Cancellation stops the current wait, not the remote stack. After a host notification, read `stack_status` once and follow the returned repair and ownership rules.

The watcher exits on attention (exit 3), a failed read that failed again on retry (exit 3), a closed, archived, or missing stack (exit 3), or a confirmed landing (exit 0). Verify missing stacks before reporting a landing. The stack is still not done until it lands. Do not subscribe to GitHub events to wait on a stack.

Auth is `MERGESTORM_API_KEY`, then `~/.mergestorm/config.json` (same as `mg`).

`context_files` passed to `review_submit` may only read files under the host-configured sandbox root (`MERGESTORM_SANDBOX_ROOT`, default: the MCP server's working directory), so a prompt-injected agent cannot use them to exfiltrate files outside it.

## Client setup

Requires Node.js 22+ and a Mergestorm API key. Run `mg login` on the machine running the MCP server, or supply `MERGESTORM_API_KEY` through the host's environment. The stdio server uses that credential; it does not provide an OAuth endpoint. An agent on that machine can sign in without a browser: `mg login --start` prints a link and a code and exits, the account owner approves the link on any device, and `mg login --finish` stores the key. Remote hosts need their own configuration and access to any reviewed checkout.

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

### Hosted endpoint

The same server runs over Streamable HTTP at `https://api.mergestorm.ai/api/v1/mcp`. Send your `mg login` key (or any Mergestorm API key) as `Authorization: Bearer <key>` on every request; each request acts only as that key's account. The endpoint is stateless (POST only, no session) and has the API's rate limit and a 256 KiB request cap. It offers every tool except the ones that read a local checkout: `review_submit`, `stack_publish` and `stack_publish_status`, and `issue_create` there needs `owner` and `repo`.

### Connection and watch checks

In each client, confirm the server connects and lists tools, then call `whoami`. It should return the account key prefix without exposing the full key. On a known owned stack, `stack_wait` with `timeout_s: 0` should return one snapshot; use `watch.next.args` for the next bounded wait. Default waits use 45-second slices, so leave the host tool timeout above 45 seconds.

Standard stdio calls are portable; task wakeups are host features. Claude Code supports background notifications in some session modes, while availability in Codex or Cursor depends on the host and execution mode. Confirm the actual notification facility before claiming automatic continuation. This server does not advertise Claude channels or install a Codex automation or Cursor extension. After reconnecting, reuse the last returned cursor; if it was lost, take a fresh snapshot rather than claiming unseen events were handled.

Tests exercise the SDK protocol, not the UI or notification delivery of all three apps. Client configuration and the host's ability to resume the task should be checked in that client.

## Results and errors

Successful results retain their existing fields in `structuredContent`, including meaningful `null` values. The same data is serialized as a text block after the human summary for clients that consume only text content. Shared workflow policy stays in server initialization instructions; stack tools include a short reminder to follow the returned watch cursor.

Failures retain `isError: true` and a readable message. `structuredContent.error` includes the original message and, when supplied by the CLI error, `code`, `reason`, `exit_code`, and `retry_after_seconds`. Missing retry metadata does not authorize repeating a write; inspect the relevant state first. The server does not manufacture request IDs or label arbitrary transport failures safe to retry.
