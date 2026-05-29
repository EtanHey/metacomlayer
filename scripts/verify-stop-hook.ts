#!/usr/bin/env bun
/**
 * verify-stop-hook.ts — live-bus check of the productized Claude push adapter
 * (`src/adapters/claude/stop-hook.ts`). Proves, against the REAL mcplayer bus:
 *   1. a message published to channel:inbox:<agent> is drained by drainAndDecide
 *      and returned as a {decision:"block",reason} the agent acts on (no poll);
 *   2. a requires_ack message gets its SHIP-3 receipt routed to the sender's
 *      PRIVATE ack channel (reply_to) — the gap the scratch drainer left open;
 *   3. the inbox message is acked (not redelivered on a second drain).
 *
 *   MCPLAYER_SOCKET=/tmp/mcplayer-bus.sock bun scripts/verify-stop-hook.ts
 */
import { RealMcplayer } from "../src/client/real-mcplayer";
import { MclClient } from "../src/client/client";
import { buildMessage, type MclEnvelope } from "../src/schema/envelope";
import { drainAndDecide } from "../src/adapters/claude/stop-hook";

const AGENT = `stopverify-${Date.now()}`;
const ACK = `channel:ack:tester-${AGENT}`;
const BODY = "Stop-hook productization check — reply not polled";

const mp = await RealMcplayer.open();
const sender = new MclClient(mp, `tester-${AGENT}`);
await sender.connect();

const receipts: MclEnvelope[] = [];
await sender.receive(ACK, ({ envelope }) => {
  receipts.push(envelope);
});

const msg = buildMessage({
  method: "mcl.headsup",
  sender: { id: "tester", role: "agent" },
  recipient: `channel:inbox:${AGENT}`,
  thread_id: "t-verify",
  subject: "verify",
  body: BODY,
  requires_ack: true,
});
msg.params.headers.reply_to = ACK;
const correlation = msg.params.headers.correlation_id;
await sender.send(msg);
console.log(
  `📤 published requires_ack → channel:inbox:${AGENT} (corr ${correlation})`,
);

// 1st drain — should find the message, block, send the receipt, ack the inbox
const decision = await drainAndDecide(AGENT, { windowMs: 800 });
await new Promise((r) => setTimeout(r, 400)); // let the receipt land

// 2nd drain — inbox was acked, so nothing should remain (no redelivery)
const second = await drainAndDecide(AGENT, { windowMs: 600 });

const checks = {
  blocked: decision?.decision === "block",
  carriesBody: !!decision?.reason.includes(BODY),
  saysNotPolled: !!decision?.reason.includes("did NOT poll"),
  receiptOnReplyTo: receipts.some(
    (e) => e.params.headers.correlation_id === correlation,
  ),
  ackedNoRedelivery: second === null,
};

console.log("\n--- DECISION (1st drain) ---");
console.log(JSON.stringify(decision, null, 2));
console.log("\n--- CHECKS ---");
for (const [k, v] of Object.entries(checks)) {
  console.log(`${v ? "✅" : "❌"} ${k}`);
}

mp.close();
const allPass = Object.values(checks).every(Boolean);
console.log(
  allPass
    ? "\n✅ VERIFIED — stop-hook adapter live on the real bus"
    : "\n❌ FAILED",
);
process.exit(allPass ? 0 : 1);
