#!/usr/bin/env bun
/**
 * a2a-publish.ts — AGENT A (publisher) for the MCL A2A demo.
 *
 * Connects to the mcplayer bus, sends a SHIP-3 HEADS-UP (requires_ack) on a
 * channel, listens for Agent B's ACK on channel:receipts, and prints the
 * VERIFIED receipt line once B has acknowledged — proving real delivery, not
 * "bytes queued".
 *
 *   MCPLAYER_SOCKET=/tmp/mcplayer-bus.sock bun scripts/a2a-publish.ts <channel> "<message>"
 *   # e.g.  … bun scripts/a2a-publish.ts channel:demo "I'm presenting Wednesday not Sunday"
 */
import { RealMcplayer } from "../src/client/real-mcplayer";
import { MclClient } from "../src/client/client";
import { ReceiptTracker } from "../src/receipts/receipts";
import { buildMessage } from "../src/schema/envelope";

const channel = process.argv[2] ?? "channel:demo";
const message = process.argv[3] ?? "I'm presenting Wednesday not Sunday";
const FROM = process.env.A2A_FROM ?? "agent-a";
const OWNER = process.env.A2A_OWNER ?? "agent-b"; // who must ACK
const RECEIPTS = "channel:receipts";

const mp = await RealMcplayer.open(); // reads MCPLAYER_SOCKET
const client = new MclClient(mp, FROM);
await client.connect();

const tracker = new ReceiptTracker(client, {
  maxAttempts: 3,
  notifier: {
    headsUp: (i) =>
      console.log(`📤 [${FROM}] HEADS-UP sent → ${i.channel}: "${message}"`),
  },
});

// listen for B's ACK on the receipts channel BEFORE we publish
await client.receive(RECEIPTS, ({ envelope }) => tracker.onAck(envelope));

const msg = buildMessage({
  method: "mcl.headsup",
  sender: { id: FROM, role: "orchestrator" },
  recipient: channel,
  thread_id: "a2a-demo",
  subject: "A2A demo — fact propagation",
  body: message,
  requires_ack: true,
});
const cid = msg.params.headers.correlation_id!;
await tracker.registerSend(msg, { expectAcksFrom: [OWNER] });
console.log(`⏳ [${FROM}] awaiting ACK from ${OWNER}  (correlation ${cid})…`);

const t0 = Date.now();
while (!tracker.isVerified(cid) && Date.now() - t0 < 30_000)
  await new Promise((r) => setTimeout(r, 200));

if (tracker.isVerified(cid)) {
  console.log(
    `\n✅ SHIP-3 VERIFIED — ${OWNER} received & ACKed "${message}"  (correlation ${cid})`,
  );
  mp.close();
  process.exit(0);
} else {
  console.error(
    `\n✗ NOT verified within 30s (state=${tracker.getState(cid)}). Is the bus + ${OWNER} subscriber running?`,
  );
  mp.close();
  process.exit(1);
}
