import { MclClient } from "../client/client";
import { buildMessage, type MclEnvelope } from "../schema/envelope";

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
 * `mcl.ack` receipt back on `channel:receipts` so the sender can reach VERIFIED.
 */

/** Each agent has a PRIVATE ack inbox so delivery receipts can't be stolen by
 * another consumer (mcplayer is competing-consumer per channel). The sender
 * stamps reply_to = its own ack channel; the receiver acks to that reply_to. */
const ackChannelFor = (id: string) => `channel:ack:${id}`;

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
    from_offset?: number;
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

  async function ensureSubscribed(channel: string): Promise<void> {
    if (subscribed.has(channel)) return;
    subscribed.add(channel);
    await client.receive(
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
      },
    );
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

    async poll({ channel, from_offset = 0, wait_ms = 2000 }) {
      await ensureSubscribed(channel);
      void from_offset; // subscription replays from 0 once; offsets are on each item
      const deadline = Date.now() + wait_ms;
      // return as soon as something is buffered, else wait up to wait_ms
      while ((inbox.get(channel)?.length ?? 0) === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
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
      return { acked: true, receipt_sent };
    },

    async status(args) {
      return client.status(args);
    },
  };
}
