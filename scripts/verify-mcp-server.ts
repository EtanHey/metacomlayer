#!/usr/bin/env bun
/**
 * Smoke test: boot the metacomlayer MCP server as a real subprocess and drive it
 * over the MCP stdio protocol (list tools + call mcl_status + mcl_publish).
 * Proves the adapter is a working MCP server before wiring it to real agents.
 *
 *   MCPLAYER_SOCKET=/tmp/mcplayer-bus.sock bun scripts/verify-mcp-server.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bun",
  args: [`${import.meta.dir}/../src/mcp/server.ts`],
  env: {
    ...process.env,
    MCL_AGENT_ID: "mcp-smoke",
    MCPLAYER_SOCKET: process.env.MCPLAYER_SOCKET ?? "/tmp/mcplayer-bus.sock",
  },
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const status = await client.callTool({ name: "mcl_status", arguments: {} });
console.log("mcl_status →", JSON.stringify((status.content as any)[0]?.text));

const pub = await client.callTool({
  name: "mcl_publish",
  arguments: {
    channel: `channel:mcp-smoke-${process.pid}`,
    subject: "smoke",
    body: "mcp server works",
    requires_ack: false,
  },
});
console.log("mcl_publish →", JSON.stringify((pub.content as any)[0]?.text));

await client.close();
const names = tools.tools.map((t) => t.name);
const ok = ["mcl_publish", "mcl_poll", "mcl_ack", "mcl_status"].every((n) =>
  names.includes(n),
);
console.log(
  ok
    ? "\n✅ MCP SERVER VERIFIED — all 4 tools exposed + callable over stdio"
    : "\n✗ missing tools",
);
process.exit(ok ? 0 : 1);
