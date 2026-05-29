#!/usr/bin/env bun
/**
 * a2a-subscribe.ts — AGENT B (subscriber) for the MCL A2A demo.
 *
 * Connects to the mcplayer bus, subscribes to a channel, and for each message:
 * prints it, ACKs the transport (mcplayer.ack → purges WAL), and sends a SHIP-3
 * mcl.ack receipt back on channel:receipts carrying the correlation_id — which
 * is what lets Agent A's ReceiptTracker reach VERIFIED.
 *
 *   MCPLAYER_SOCKET=/tmp/mcplayer-bus.sock bun scripts/a2a-subscribe.ts <channel>
 *   # e.g.  … bun scripts/a2a-subscribe.ts channel:demo
 */
import { RealMcplayer } from "../src/client/real-mcplayer";
import { MclClient } from "../src/client/client";
import { buildMessage } from "../src/schema/envelope";

const channel = process.argv[2] ?? "channel:demo";
const AS = process.env.A2A_AS ?? "agent-b";
const RECEIPTS = "channel:receipts";

const mp = await RealMcplayer.open(); // reads MCPLAYER_SOCKET
const client = new MclClient(mp, AS);
await client.connect();
console.log(`👂 [${AS}] subscribed to ${channel} — waiting for messages…`);

await client.receive(channel, async ({ envelope, raw }) => {
  const from = envelope.params.routing.sender.id;
  console.log(
    `📥 [${AS}] received from ${from}: "${envelope.params.payload.body}"`,
  );

  // ACK the transport message (advance offset / purge WAL)
  await client.ack(channel, raw.message_id);

  // send the SHIP-3 receipt back so the publisher can VERIFY
  const cid = envelope.params.headers.correlation_id;
  if (envelope.params.delivery_control.requires_ack && cid) {
    const ack = buildMessage({
      method: "mcl.ack",
      sender: { id: AS, role: "owner" },
      recipient: RECEIPTS,
      thread_id: envelope.params.routing.thread_id,
      subject: "ack",
      body: cid,
      requires_ack: false,
    });
    ack.params.headers.correlation_id = cid;
    await client.send(ack);
    console.log(`📨 [${AS}] ACKed correlation ${cid} → ${RECEIPTS}`);
  }
});

// stay alive to keep receiving
await new Promise(() => {});
