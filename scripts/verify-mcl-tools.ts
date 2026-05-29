#!/usr/bin/env bun
/**
 * Functional proof that the MCL toolset (the MCP adapter core) works over the
 * REAL mcplayer bus: agent A publishes a requires_ack message, agent B polls +
 * acks, agent A polls channel:receipts and sees B's SHIP-3 receipt.
 *
 *   MCPLAYER_SOCKET=/tmp/mcplayer-bus.sock bun scripts/verify-mcl-tools.ts
 */
import { RealMcplayer } from "../src/client/real-mcplayer";
import { MclClient } from "../src/client/client";
import { createMclToolset } from "../src/mcp/mcl-tools";

const CH = `channel:tooltest-${process.pid}`;
const RECEIPTS = "channel:receipts";

const mpA = await RealMcplayer.open();
const a = new MclClient(mpA, "tool-test-a");
await a.connect();
const toolsA = createMclToolset(a, "tool-test-a");

const mpB = await RealMcplayer.open();
const b = new MclClient(mpB, "tool-test-b");
await b.connect();
const toolsB = createMclToolset(b, "tool-test-b");

console.log("status:", JSON.stringify(await toolsA.status()));

const pub = await toolsA.publish({
  channel: CH,
  subject: "fact",
  body: "I'm presenting Wednesday not Sunday",
  requires_ack: true,
});
console.log("A published:", JSON.stringify(pub));

const got = await toolsB.poll({ channel: CH, wait_ms: 3000 });
console.log(
  "B polled:",
  JSON.stringify(
    got.messages.map((m) => ({
      from: m.from,
      body: m.body,
      message_id: m.message_id,
      correlation_id: m.correlation_id,
    })),
  ),
);
if (got.messages.length === 0) {
  console.error("✗ B received nothing");
  process.exit(1);
}

const ackRes = await toolsB.ack({
  channel: CH,
  message_id: got.messages[0]!.message_id,
});
console.log("B ack:", JSON.stringify(ackRes));

const receipts = await toolsA.poll({ channel: RECEIPTS, wait_ms: 3000 });
const matched = receipts.messages.find((m) => m.body === pub.correlation_id);
console.log(
  "A receipts poll:",
  JSON.stringify(receipts.messages.map((m) => m.body)),
);

mpA.close();
mpB.close();
if (ackRes.receipt_sent && matched) {
  console.log(
    `\n✅ TOOLSET VERIFIED over real bus — A→B delivery + SHIP-3 receipt (correlation ${pub.correlation_id})`,
  );
  process.exit(0);
}
console.error(
  `\n✗ receipt not confirmed (receipt_sent=${ackRes.receipt_sent}, matched=${!!matched})`,
);
process.exit(1);
