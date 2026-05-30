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

const AGENT_ID = "mcp-smoke";
const transport = new StdioClientTransport({
  command: "bun",
  args: [`${import.meta.dir}/../src/mcp/server.ts`],
  env: {
    ...process.env,
    MCL_AGENT_ID: AGENT_ID,
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

// registry tools: register self, then list — self must appear in the roster
const reg = await client.callTool({
  name: "mcl_register",
  arguments: { role: "smoke", capabilities: ["test"] },
});
console.log("mcl_register →", JSON.stringify((reg.content as any)[0]?.text));
const list = await client.callTool({ name: "mcl_agents", arguments: {} });
const listText = (list.content as any)[0]?.text ?? "{}";
console.log("mcl_agents →", listText);
const selfListed = JSON.parse(listText).agents?.some(
  (a: { id: string }) => a.id === AGENT_ID,
);

await client.close();
const names = tools.tools.map((t) => t.name);
const expected = [
  "mcl_publish",
  "mcl_poll",
  "mcl_ack",
  "mcl_status",
  "mcl_register",
  "mcl_deregister",
  "mcl_agents",
];
const ok = expected.every((n) => names.includes(n)) && selfListed;
console.log(
  ok
    ? `\n✅ MCP SERVER VERIFIED — all ${expected.length} tools exposed + callable over stdio; self appears in roster`
    : "\n✗ missing tools or self not in roster",
);
process.exit(ok ? 0 : 1);
