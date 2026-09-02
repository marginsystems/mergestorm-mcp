# mergestorm-mcp

Stdio MCP server for Mergestorm. Tools: `whoami`, `credits`, `review_list`, `review_get`, `review_get_pr`, `review_submit`, `review_wait`, `review_wait_pr`, `stack_list`, `stack_status`, `queue_status`, `settings_get`, `settings_set`.

The stack tools are read-only:

- `stack_list` returns the current API key owner's registered stacks.
- `stack_status({ stack_id })` returns one owned stack with enriched checks and agent state, or a structured `stack_not_found` error.

Auth is `MERGESTORM_API_KEY`, then `~/.mergestorm/config.json` (same as `mg`).

`context_files` passed to `review_submit` may only read files under the host-configured sandbox root (`MERGESTORM_SANDBOX_ROOT`, default: the MCP server's working directory), so a prompt-injected agent cannot use them to exfiltrate files outside it.

```bash
claude mcp add mergestorm -- npx -y mergestorm-mcp
```

Then call `whoami`. It should return the key prefix.

Requires Node.js 22+ and a Mergestorm API key (`mg login` or `MERGESTORM_API_KEY`).
