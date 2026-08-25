# mergestorm-mcp

Stdio MCP server for Mergestorm. Tools: `whoami`, `credits`, `review_list`, `review_get`, `review_submit`, `review_wait`.

Auth is `MERGESTORM_API_KEY`, then `~/.mergestorm/config.json` (same as `mg`).

`context_files` passed to `review_submit` may only read files under the host-configured sandbox root (`MERGESTORM_SANDBOX_ROOT`, default: the MCP server's working directory), so a prompt-injected agent cannot use them to exfiltrate files outside it.

```bash
claude mcp add mergestorm -- npx -y mergestorm-mcp
```

Then call `whoami`. It should return the key prefix.

Requires Node.js 22+ and a Mergestorm API key (`mg login` or `MERGESTORM_API_KEY`).
