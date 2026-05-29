/**
 * MCL Claude push adapter — the Stop hook.
 *
 * A request/response LLM agent can't be interrupted mid-thought, so out-of-band
 * "push" means: at the agent's TURN BOUNDARY, drain its private MCL inbox and, if
 * mail is waiting, return `{decision:"block",reason}` to Claude Code's Stop hook.
 * Claude feeds `reason` back INTO the agent's next turn — out-of-band, NOT typed
 * into the input line, with no busy-polling. This is the harness-native Claude
 * channel (verified live; see docs/PUSH-AND-INBOX.md). Codex/Cursor get their own
 * turn-boundary equivalents on the same MCL envelope.
 *
 * `formatStopDecision` is the pure core (no I/O); `drainAndDecide` wires it to the
 * real mcplayer bus via the repo's tested client.
 */
import { RealMcplayer } from "../../client/real-mcplayer";
import { MclClient } from "../../client/client";
import { buildMessage } from "../../schema/envelope";

export interface DrainedMessage {
  from: string;
  body: string;
  offset: number;
  message_id: string;
  /** correlation_id + reply_to carried so the drainer can send the SHIP-3 receipt. */
  correlation_id?: string;
  requires_ack?: boolean;
  thread_id?: string;
  reply_to?: string;
}

export interface StopHookDecision {
  decision: "block";
  reason: string;
}

/** Per-agent private channels (competing-consumer safe — see PUSH-AND-INBOX.md). */
export const inboxChannelFor = (agentId: string) => `channel:inbox:${agentId}`;
export const ackChannelFor = (agentId: string) => `channel:ack:${agentId}`;

/**
 * Pure: drained inbox messages → the Stop-hook decision. Empty inbox → null
 * (allow the agent to stop). Non-empty → block, listing messages OLDEST-FIRST by
 * offset so a burst arrives in order, batched into one out-of-band hand-off.
 */
export function formatStopDecision(
  items: DrainedMessage[],
): StopHookDecision | null {
  if (items.length === 0) return null;
  const lines = [...items]
    .sort((a, b) => a.offset - b.offset)
    .map((m) => `• from ${m.from}: ${m.body}`);
  return {
    decision: "block",
    reason:
      `📨 MCL inbox push (${items.length} message(s) delivered out-of-band via Stop hook — you did NOT poll for these):\n` +
      lines.join("\n") +
      `\n\nAcknowledge them and act if needed.`,
  };
}

/**
 * Drain `channel:inbox:<agentId>` off the real mcplayer bus at the turn boundary,
 * send the SHIP-3 reply_to receipt for any requires_ack message (so the sender
 * reaches VERIFIED — the gap the scratch drainer left open), ack each bus message
 * so it isn't re-delivered next turn, and return the Stop-hook decision.
 *
 * Live I/O via the repo's tested RealMcplayer + MclClient. Throws on bus failure;
 * the caller (`main`) treats any throw as "allow the stop" so the agent never wedges.
 */
export async function drainAndDecide(
  agentId: string,
  opts: { windowMs?: number } = {},
): Promise<StopHookDecision | null> {
  const inbox = inboxChannelFor(agentId);
  const windowMs = opts.windowMs ?? Number(process.env.MCL_DRAIN_MS ?? 700);

  const mp = await RealMcplayer.open(); // MCPLAYER_SOCKET
  const client = new MclClient(mp, `stophook-${agentId}`);
  await client.connect();

  const items: DrainedMessage[] = [];
  const sub = await client.receive(inbox, ({ envelope, raw }) => {
    const p = envelope.params;
    items.push({
      from: p.routing.sender.id,
      body: p.payload.body,
      offset: raw.offset,
      message_id: raw.message_id,
      correlation_id: p.headers.correlation_id,
      requires_ack: p.delivery_control.requires_ack,
      thread_id: p.routing.thread_id,
      reply_to: p.headers.reply_to,
    });
  });

  // let the bus replay the backlog of un-acked messages (from_offset:0)
  await new Promise((r) => setTimeout(r, windowMs));

  // SHIP-3: receipt to the SENDER's private ack channel (reply_to), then ack the
  // inbox message. Oldest-first so receipts mirror delivery order.
  for (const m of [...items].sort((a, b) => a.offset - b.offset)) {
    if (m.requires_ack) {
      const receiptChannel = m.reply_to ?? ackChannelFor(m.from);
      const receipt = buildMessage({
        method: "mcl.ack",
        sender: { id: agentId, role: "agent" },
        recipient: receiptChannel,
        thread_id: m.thread_id ?? m.message_id,
        subject: "ack",
        body: m.correlation_id ?? "",
        requires_ack: false,
      });
      if (m.correlation_id)
        receipt.params.headers.correlation_id = m.correlation_id;
      await client.send(receipt);
    }
    await client.ack(inbox, m.message_id);
  }

  sub.unsubscribe();
  mp.close();
  return formatStopDecision(items);
}

/** Stop-hook entrypoint: print the block-decision JSON on mail, else exit 0. */
async function main(): Promise<void> {
  const agentId = process.env.MCL_AGENT_ID;
  if (!agentId) {
    // misconfigured hook → never wedge the agent
    process.exit(0);
  }
  try {
    const decision = await drainAndDecide(agentId);
    if (decision) process.stdout.write(JSON.stringify(decision));
  } catch {
    // bus unreachable / any failure → allow the stop (fail-safe)
  }
  process.exit(0);
}

if (import.meta.main) {
  void main();
}
