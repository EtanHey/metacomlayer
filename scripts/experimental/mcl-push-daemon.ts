#!/usr/bin/env bun
/**
 * ⛔ BROKEN MECHANISM — INPUT-JAMMING. DO NOT USE. DO NOT SHIP. ⛔
 * ---------------------------------------------------------------------------
 * RETRACTED 2026-05-30. This daemon "pushes" by calling `cmux send` / `send-key`,
 * which types the message into the agent's TUI INPUT LINE (the `❯` prompt). That
 * is the exact stdin/PTY keystroke-injection anti-pattern MCL exists to REPLACE:
 * delivery is IN-BAND and interrupts the prompt. A 5-message burst proved it
 * (arrived #4,#3,#5,#2,#1, concatenated into one line with stray keystrokes).
 *
 * The serialized-queue rewrite below fixes the ORDER/concatenation SYMPTOMS, but
 * the MECHANISM is still wrong (still typing into the input line). Kept ONLY as
 * reference for the bus-side wiring (subscribe → ack → reply_to receipt).
 *
 * The real push is OUT-OF-BAND, channels-per-harness on the OpenAI-SDK envelope
 * (see docs/PUSH-AND-INBOX.md and src/mcp/claude-channel.ts). Do not revive this.
 * ---------------------------------------------------------------------------
 *
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
import { buildMessage, type MclEnvelope } from "../src/schema/envelope";

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

// SERIALIZED, ORDERED injection. The receive handler ONLY enqueues (preserving
// arrival order); a single worker drains the queue one message at a time,
// awaiting each send+return fully (plus a settle gap) before the next. A burst
// therefore arrives IN ORDER as DISTINCT submits — never concatenated or
// interleaved (the bug a 5-message burst exposed when handlers ran concurrently).
type Item = {
  envelope: MclEnvelope;
  raw: { message_id: string; offset: number };
};
const queue: Item[] = [];
let draining = false;

async function inject(item: Item): Promise<void> {
  const { envelope, raw } = item;
  const from = envelope.params.routing.sender.id;
  const body = envelope.params.payload.body;
  const cid = envelope.params.headers.correlation_id;
  const requires_ack = envelope.params.delivery_control.requires_ack;
  const text =
    `[MCL push] from ${from}: "${body}"` +
    (requires_ack ? ` (ack via your mcl tools; correlation ${cid})` : "");

  const sendCode = await cmux(["send", "--surface", surface, text]);
  const keyCode =
    sendCode === 0
      ? await cmux(["send-key", "--surface", surface, "return"])
      : sendCode;
  if (sendCode !== 0 || keyCode !== 0) {
    // injection FAILED (e.g. surface closed) — do NOT ack; the WAL redelivers it.
    console.error(
      `[${stamp()}] ✗ inject FAILED into ${surface} (send=${sendCode} key=${keyCode}) — UNacked for redelivery`,
    );
    return;
  }
  console.log(
    `[${stamp()}] ✓ injected #${raw.offset} from ${from} → ${surface}`,
  );

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
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length) {
    await inject(queue.shift()!);
    // settle: let the PTY consume this submit before the next so a rapid burst
    // doesn't merge into one input line.
    await new Promise((r) => setTimeout(r, 250));
  }
  draining = false;
}

await client.receive(INBOX, ({ envelope, raw }) => {
  queue.push({ envelope, raw }); // enqueue in arrival order
  void drain();
});

// run until killed
await new Promise(() => {});
