#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMergestormMcpServer } from "./server.js";

const server = createMergestormMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
