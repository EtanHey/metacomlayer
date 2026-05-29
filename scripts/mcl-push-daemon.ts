#!/usr/bin/env bun
/**
 * mcl-push-daemon — TRUE async push for a request/response LLM agent.
 *
 * An LLM agent can't be interrupted mid-thought, so "push" = the bus delivers on
 * arrival (event-driven, no busy-loop) AND the vendor adapter INJECTS the message
 * into the agent's session so it's handed the message instead of asking for it.
 *
 * This daemon owns the subscription to ONE agent's PRIVATE inbox (so the agent
 * never calls mcl_poll). The transport is the durable mcplayer bus; injection is
 * just the last-mile render into the agent's cmux pane via `cmux send`.
 *
 *   MCPLAYER_SOCKET=/tmp/mcplayer-bus.sock bun scripts/mcl-push-daemon.ts <agentId> <surface>
 *   # e.g. … bun scripts/mcl-push-daemon.ts agent-b surface:155
 */
import { RealMcplayer } from "../src/client/real-mcplayer";
import { MclClient } from "../src/client/client";
import { buildMessage } from "../src/schema/envelope";

const agentId = process.argv[2];
const surface = process.argv[3];
if (!agentId || !surface) {
  console.error(
    "usage: mcl-push-daemon.ts <agentId> <surface>  (e.g. agent-b surface:155)",
  );
  process.exit(2);
}
const INBOX = `channel:inbox:${agentId}`;

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

async function cmux(args: string[]): Promise<number> {
  const p = Bun.spawn(["cmux", ...args], { stdout: "pipe", stderr: "pipe" });
  return await p.exited; // exit code: 0 = delivered, non-zero = surface dead/unreachable
}

const mp = await RealMcplayer.open(); // MCPLAYER_SOCKET
const client = new MclClient(mp, `push-daemon-${agentId}`);
await client.connect();
console.log(
  `MCL_PUSH_DAEMON listening inbox=${INBOX} → injecting into ${surface}`,
);

await client.receive(INBOX, async ({ envelope, raw }) => {
  const from = envelope.params.routing.sender.id;
  const body = envelope.params.payload.body;
  const subject = envelope.params.payload.subject;
  const cid = envelope.params.headers.correlation_id;
  const requires_ack = envelope.params.delivery_control.requires_ack;
  console.log(
    `[${stamp()}] push ← ${from}: ${subject} → injecting into ${surface}`,
  );

  // INJECT into the agent's session (last-mile render; transport was the bus)
  const text =
    `[MCL push] Message from ${from} on your inbox: "${body}"` +
    (requires_ack
      ? `  (reply/ack via your mcl tools; correlation ${cid})`
      : "");
  const sendCode = await cmux(["send", "--surface", surface, text]);
  const keyCode =
    sendCode === 0
      ? await cmux(["send-key", "--surface", surface, "return"])
      : sendCode;
  if (sendCode !== 0 || keyCode !== 0) {
    // injection FAILED (e.g. surface closed) — do NOT ack, so the message stays
    // in the WAL and is redelivered to a future subscriber (at-least-once).
    console.error(
      `[${stamp()}] ✗ inject FAILED into ${surface} (send=${sendCode} key=${keyCode}) — leaving message UNacked for redelivery`,
    );
    return;
  }

  // delivered: ack the transport message + fire the SHIP-3 receipt to reply_to
  await client.ack(INBOX, raw.message_id);
  const reply_to = envelope.params.headers.reply_to;
  if (requires_ack && cid && reply_to) {
    const receipt = buildMessage({
      method: "mcl.ack",
      sender: { id: agentId, role: "agent" },
      recipient: reply_to,
      thread_id: envelope.params.routing.thread_id,
      subject: "ack",
      body: cid,
      requires_ack: false,
    });
    receipt.params.headers.correlation_id = cid;
    await client.send(receipt);
    console.log(`[${stamp()}] receipt → ${reply_to} (correlation ${cid})`);
  }
});

// run until killed
await new Promise(() => {});
