# mergestorm-mcp

Stdio MCP server for Mergestorm. Tools: `whoami`, `credits`, `review_list`, `review_get`, `review_get_pr`, `review_submit`, `review_wait`, `review_wait_pr`, `stack_adopt`, `stack_list`, `stack_set`, `stack_status`, `stack_wait`, `queue_status`, `settings_get`, `settings_set`.

The stack tools expose reads plus one scoped policy write:

- `stack_adopt({ owner, repo, pr_number, auto_land?, auto_review?, auto_patch? })` adopts an open PR chain with optional per-stack policy. Omitted policy does not force Cyclone off. `auto_review` and `auto_patch` accept `true`, `false`, or `null`; `null` clears the override. Read `stack_status` with the returned `result.stack.id` to verify policy and Cyclone ownership.
- `stack_list` returns the current API key owner's registered stacks.
- `stack_set({ stack_id, auto_land?, auto_review?, auto_patch? })` sets per-stack policy on one owned stack. `auto_land` flips Auto land. `auto_review` and `auto_patch` pin Vortex auto-review or Cyclone auto-patch for that stack in either direction (`true` or `false`); `null` clears the pin so the stack follows the account setting. Pass at least one key. Account settings are never changed here.
- `stack_status({ stack_id })` returns one owned stack with enriched checks and agent state, plus `attention`, `issues`, and `currentCandidate` from the same blocker rules as `stack_wait`, read against that stack's own merge queue. It returns a structured `stack_not_found` or `rate_limited` error.
- `stack_wait({ stack_id, timeout_s?, enrolled_head_sha?, after_finished_at?, bounce_id? })` waits for a stack or queue state change and returns the latest snapshots. `timeout_s: 0` returns one snapshot; a positive timeout after a snapshot with no attention returns the current `waiting` or `in_progress` status with selectors to use for the next call. An unread deadline returns `failed`.

Auth is `MERGESTORM_API_KEY`, then `~/.mergestorm/config.json` (same as `mg`).

`context_files` passed to `review_submit` may only read files under the host-configured sandbox root (`MERGESTORM_SANDBOX_ROOT`, default: the MCP server's working directory), so a prompt-injected agent cannot use them to exfiltrate files outside it.

```bash
claude mcp add mergestorm -- npx -y mergestorm-mcp
```

Then call `whoami`. It should return the key prefix.

Requires Node.js 22+ and a Mergestorm API key (`mg login` or `MERGESTORM_API_KEY`).
