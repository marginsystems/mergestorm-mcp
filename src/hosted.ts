import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMergestormMcpServer } from "./server.js";

export { MCP_HOSTED_TOOL_NAMES, MCP_SERVER_INSTRUCTIONS, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./server.js";

export type HostedMcpCaller = {
  apiKey: string;
  apiBase: string;
  chatId?: string | null;
};

export async function handleHostedMcpRequest(request: Request, caller: HostedMcpCaller): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this endpoint is stateless, send JSON-RPC with POST." }, id: null },
      { status: 405, headers: { allow: "POST" } },
    );
  }
  const server = createMergestormMcpServer({
    hosted: true,
    chatId: caller.chatId ?? null,
    config: { apiKey: caller.apiKey, apiBase: caller.apiBase, ignoreEnv: true },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
