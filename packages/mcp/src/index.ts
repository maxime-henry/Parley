import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ParleyClient } from "./client.ts";
import { createMcpServer } from "./server.ts";

const url = process.env.PARLEY_URL;
const token = process.env.PARLEY_TOKEN;
if (!url || !token) {
  console.error("Set PARLEY_URL and PARLEY_TOKEN.");
  process.exit(1);
}

await createMcpServer(new ParleyClient(url, token)).connect(new StdioServerTransport());
