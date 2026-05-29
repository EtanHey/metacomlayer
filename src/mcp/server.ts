#!/usr/bin/env bun
/**
 * metacomlayer MCP server — the Claude/Codex ADAPTER.
 *
 * A stdio MCP server any MCP-capable agent (Claude Code, Codex CLI) connects to.
 * It maps the agent's tool-calls onto MCL operations over the mcplayer bus, so a
 * REAL agent uses MCL as a tool: it DECIDES to message (mcl_publish), RECEIVES
 * (mcl_poll), and ACKs (mcl_ack) — no script driving it.
 *
 * Identity: MCL_AGENT_ID env (the agent's id on the bus). Bus: MCPLAYER_SOCKET
 * env (default /tmp/mcplayer-bus.sock).
 *
 *   MCL_AGENT_ID=claude-a MCPLAYER_SOCKET=/tmp/mcplayer-bus.sock bun src/mcp/server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RealMcplayer } from "../client/real-mcplayer";
import { MclClient } from "../client/client";
import { createMclToolset } from "./mcl-tools";

const AGENT_ID = process.env.MCL_AGENT_ID ?? "mcl-agent";

const mp = await RealMcplayer.open(); // MCPLAYER_SOCKET
const client = new MclClient(mp, AGENT_ID);
await client.connect();
const tools = createMclToolset(client, AGENT_ID);

const server = new McpServer({ name: "metacomlayer", version: "0.1.0" });

server.tool(
  "mcl_publish",
  "Send a message to other agents on an MCL channel. Set requires_ack=true to demand a verifiable delivery receipt; the result includes a correlation_id and a private receipt_channel — confirm delivery by calling mcl_poll on THAT receipt_channel (your own channel:ack:<id>), never a shared channel.",
  {
    channel: z.string().describe('Channel to publish to, e.g. "channel:demo"'),
    subject: z.string().describe("Short subject line"),
    body: z.string().describe("The message body"),
    requires_ack: z
      .boolean()
      .optional()
      .describe("Demand a SHIP-3 ACK receipt (default false)"),
  },
  async (args) => {
    const r = await tools.publish(args);
    return { content: [{ type: "text", text: JSON.stringify(r) }] };
  },
);

server.tool(
  "mcl_poll",
  "Receive messages on an MCL channel. This is an event-driven LONG-POLL: it BLOCKS and returns the instant a message arrives (or after wait_ms with none). Call it ONCE and wait — do NOT loop it in a busy retry cycle. Subscribes on first call; returns sender, subject, body, message_id, correlation_id, requires_ack for each.",
  {
    channel: z
      .string()
      .describe('Channel to receive from, e.g. "channel:demo"'),
    wait_ms: z
      .number()
      .optional()
      .describe(
        "Max ms to block waiting for a message (default 30000). Returns immediately on arrival.",
      ),
  },
  async (args) => {
    const r = await tools.poll(args);
    return { content: [{ type: "text", text: JSON.stringify(r) }] };
  },
);

server.tool(
  "mcl_ack",
  "Acknowledge a received message: purges it from the queue AND, if it required an ack, sends the SHIP-3 receipt back so the sender reaches VERIFIED. Call this after you have acted on a message from mcl_poll.",
  {
    channel: z.string(),
    message_id: z.string().describe("message_id from the mcl_poll result"),
  },
  async (args) => {
    const r = await tools.ack(args);
    return { content: [{ type: "text", text: JSON.stringify(r) }] };
  },
);

server.tool(
  "mcl_status",
  "Check the MCL bus engine health (up/busy/building/not-up).",
  {},
  async () => {
    const r = await tools.status();
    return { content: [{ type: "text", text: JSON.stringify(r) }] };
  },
);

await server.connect(new StdioServerTransport());
// stderr is safe for logs (stdout is the MCP transport)
console.error(
  `[metacomlayer-mcp] ${AGENT_ID} connected to ${process.env.MCPLAYER_SOCKET ?? "/tmp/mcplayer.sock"}`,
);
