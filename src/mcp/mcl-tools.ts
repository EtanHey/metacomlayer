import { MclClient } from "../client/client";
import { buildMessage, type MclEnvelope } from "../schema/envelope";
import { ackChannelFor } from "../schema/channels";

/**
 * mcl-tools — the agent-facing operations behind the MCL MCP server. This is the
 * per-vendor ADAPTER core: it maps an agent's tool-calls (publish / poll / ack /
 * status) onto MCL channel operations over mcplayer, so a REAL agent (Claude
 * Code, Codex) uses MCL as a tool instead of a script driving it.
 *
 * Receive is POLL-based (tool-call ergonomics): the toolset subscribes to a
 * channel on first poll, buffers inbound messages, and each `poll` drains what
 * arrived (waiting briefly for in-flight delivery). `ack` purges the transport
 * message AND, when the message required acknowledgement, sends the SHIP-3
 * `mcl.ack` receipt back to the sender's PRIVATE ack channel (the message's
 * reply_to) so the sender can reach VERIFIED — never a shared channel.
 *
 * Private-channel conventions (inbox/ack) live in ../schema/channels.
 */

export interface InboxItem {
  from: string;
  subject: string;
  body: string;
  channel: string;
  message_id: string;
  offset: number;
  correlation_id?: string;
  requires_ack: boolean;
  thread_id: string;
  reply_to?: string;
}

export interface MclToolset {
  publish(args: {
    channel: string;
    subject: string;
    body: string;
    requires_ack?: boolean;
  }): Promise<{
    channel: string;
    message_id: string;
    offset: number;
    correlation_id?: string;
    receipt_channel?: string;
  }>;
  poll(args: {
    channel: string;
    wait_ms?: number;
  }): Promise<{ messages: InboxItem[] }>;
  ack(args: {
    channel: string;
    message_id: string;
  }): Promise<{ acked: boolean; receipt_sent: boolean }>;
  status(args?: {
    engine?: string;
  }): Promise<{ state: string; since?: number | string }>;
}

export function createMclToolset(
  client: MclClient,
  selfId: string,
): MclToolset {
  const inbox = new Map<string, InboxItem[]>();
  const meta = new Map<string, InboxItem>(); // message_id -> item (for ack receipts)
  const subscribed = new Set<string>();
  // in-flight subscribe attempts — dedupes concurrent first-polls AND lets a
  // FAILED subscribe be retried (the channel is only marked `subscribed` after
  // receive resolves, so a transient failure never poisons it).
  const subscribing = new Map<string, Promise<void>>();
  // per-channel arrival waiters — resolved the INSTANT a pushed message lands,
  // so poll is an event-driven long-block (no busy-loop, no agent retry loop).
  const waiters = new Map<string, Array<() => void>>();

  function wake(channel: string): void {
    const ws = waiters.get(channel);
    if (ws && ws.length) {
      waiters.set(channel, []);
      for (const w of ws) w();
    }
  }

  async function ensureSubscribed(channel: string): Promise<void> {
    if (subscribed.has(channel)) return;
    const existing = subscribing.get(channel);
    if (existing) return existing;
    const attempt = client
      .receive(
        channel,
        ({
          envelope,
          raw,
        }: {
          envelope: MclEnvelope;
          raw: { message_id: string; offset: number };
        }) => {
          const item: InboxItem = {
            from: envelope.params.routing.sender.id,
            subject: envelope.params.payload.subject,
            body: envelope.params.payload.body,
            channel,
            message_id: raw.message_id,
            offset: raw.offset,
            correlation_id: envelope.params.headers.correlation_id,
            requires_ack: envelope.params.delivery_control.requires_ack,
            thread_id: envelope.params.routing.thread_id,
            reply_to: envelope.params.headers.reply_to,
          };
          const arr = inbox.get(channel) ?? [];
          arr.push(item);
          inbox.set(channel, arr);
          meta.set(raw.message_id, item);
          wake(channel); // deliver-on-arrival: unblock any waiting poll immediately
        },
      )
      .then(() => {
        // mark subscribed ONLY after receive resolves — a thrown receive leaves the
        // channel unsubscribed so the next poll retries instead of hanging forever.
        subscribed.add(channel);
      });
    subscribing.set(channel, attempt);
    try {
      await attempt;
    } finally {
      subscribing.delete(channel);
    }
  }

  return {
    async publish({ channel, subject, body, requires_ack = false }) {
      const receipt_channel = ackChannelFor(selfId);
      const msg = buildMessage({
        method: requires_ack ? "mcl.headsup" : "mcl.broadcast",
        sender: { id: selfId, role: "agent" },
        recipient: channel,
        thread_id: `mcl-${selfId}`,
        subject,
        body,
        requires_ack,
      });
      // route any delivery receipt to OUR private ack channel (no contention)
      msg.params.headers.reply_to = receipt_channel;
      const { offset } = await client.send(msg);
      return {
        channel,
        message_id: msg.params.routing.message_id,
        offset,
        correlation_id: msg.params.headers.correlation_id,
        receipt_channel,
      };
    },

    async poll({ channel, wait_ms = 30000 }) {
      await ensureSubscribed(channel);
      // The subscription replays from offset 0 once; per-message offsets are on
      // each returned item. (No from_offset arg: this buffered long-poll drains
      // whatever has arrived, so a caller-supplied offset would be meaningless.)
      // Event-driven long-poll: if nothing is buffered, block on a promise that
      // the push handler resolves the instant a message arrives (or wait_ms
      // timeout). No polling interval, no CPU spin — return on arrival.
      if ((inbox.get(channel)?.length ?? 0) === 0) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const fire = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const arr = waiters.get(channel) ?? [];
          arr.push(fire);
          waiters.set(channel, arr);
          const timer = setTimeout(fire, wait_ms);
        });
      }
      const messages = inbox.get(channel) ?? [];
      inbox.set(channel, []); // drain
      return { messages };
    },

    async ack({ channel, message_id }) {
      await client.ack(channel, message_id);
      const item = meta.get(message_id);
      let receipt_sent = false;
      if (item?.requires_ack && item.correlation_id) {
        // reply to the SENDER's private ack channel (reply_to); fall back to a
        // per-sender ack channel derived from the sender id.
        const receiptChannel = item.reply_to ?? ackChannelFor(item.from);
        const receipt = buildMessage({
          method: "mcl.ack",
          sender: { id: selfId, role: "agent" },
          recipient: receiptChannel,
          thread_id: item.thread_id,
          subject: "ack",
          body: item.correlation_id,
          requires_ack: false,
        });
        receipt.params.headers.correlation_id = item.correlation_id;
        await client.send(receipt);
        receipt_sent = true;
      }
      meta.delete(message_id); // purge: bounds the map + makes a repeat ack a no-op
      return { acked: true, receipt_sent };
    },

    async status(args) {
      return client.status(args);
    },
  };
}
