import {
  type Mcplayer,
  type ChannelMessage,
  type Subscription,
  type McplayerStatus,
  type EngineState,
  McplayerError,
  MCPLAYER_ERR,
} from "./mcplayer-interface";

interface StoredMessage {
  message_id: string;
  payload: unknown;
  offset: number;
  acked: boolean;
}

interface ChannelState {
  nextOffset: number;
  messages: StoredMessage[];
  seen: Set<string>;
}

/** Serializable WAL snapshot — models mcplayer's durable state across a restart. */
export interface McplayerSnapshot {
  channels: Record<string, { nextOffset: number; messages: StoredMessage[] }>;
}

interface MockOptions {
  /** bounded WAL: max UN-ACKED messages per channel before BUSY nack (A2). */
  capacityPerChannel?: number;
  engineState?: EngineState;
  snapshot?: McplayerSnapshot;
}

/**
 * In-memory two-plane mock of mcplayer. NOT production — it exists so MCL builds
 * against the exact seam contract in parallel with the real mcplayer.
 *
 * Plane separation (A1) is enforced structurally: connect()/status() never read
 * or mutate `channels`, and honor `queueFaulted` only on the queue methods.
 */
export class MockMcplayer implements Mcplayer {
  private sessions = new Map<string, string>();
  private channels = new Map<string, ChannelState>();
  private subscribers = new Map<
    string,
    Array<(m: ChannelMessage) => void | Promise<void>>
  >();
  private capacity: number;
  private engineState: EngineState;

  /** test affordance: simulate a queue-subsystem fault (A1 — must not affect connect/status). */
  queueFaulted = false;

  constructor(opts: MockOptions = {}) {
    this.capacity = opts.capacityPerChannel ?? 1024;
    this.engineState = opts.engineState ?? "up";
    if (opts.snapshot) {
      for (const [name, c] of Object.entries(opts.snapshot.channels)) {
        this.channels.set(name, {
          nextOffset: c.nextOffset,
          messages: c.messages.map((m) => ({ ...m })),
          seen: new Set(c.messages.map((m) => m.message_id)),
        });
      }
    }
  }

  // ---- connection plane (independent of the queue plane) ----

  async connect(p: { client_id: string }): Promise<{ session_id: string }> {
    // never blocks on engine availability (A1)
    const session_id = `sess:${p.client_id}`;
    this.sessions.set(p.client_id, session_id); // idempotent by client_id
    return { session_id };
  }

  async status(_p?: { engine?: string }): Promise<McplayerStatus> {
    // answerable WHILE the engine is down and WHILE the queue is faulted (A1)
    return { state: this.engineState };
  }

  setEngineState(s: EngineState): void {
    this.engineState = s;
  }

  // ---- queue plane ----

  async publish(p: {
    channel: string;
    message_id: string;
    payload: unknown;
    durable?: boolean;
  }): Promise<{ enqueued: true; offset: number }> {
    // queue-plane fault = standard JSON-RPC internal error (-32603), matching
    // mcplayer PROTOCOL.md (no invented -32500) so mock↔real stay congruent (A1).
    if (this.queueFaulted)
      throw new McplayerError(MCPLAYER_ERR.QUEUE_FAULT, "queue plane faulted");
    const ch = this.getOrCreate(p.channel);

    // idempotent on message_id (dedupe re-publishes)
    if (ch.seen.has(p.message_id)) {
      const existing = ch.messages.find((m) => m.message_id === p.message_id)!;
      return { enqueued: true, offset: existing.offset };
    }

    // bounded WAL → BUSY nack, never silent drop (A2)
    const unacked = ch.messages.filter((m) => !m.acked).length;
    if (unacked >= this.capacity) {
      throw new McplayerError(
        MCPLAYER_ERR.WAL_FULL,
        `WAL full on channel ${p.channel} (capacity ${this.capacity})`,
      );
    }

    const offset = ch.nextOffset++; // monotonic, never reused (A2)
    const stored: StoredMessage = {
      message_id: p.message_id,
      payload: p.payload,
      offset,
      acked: false,
    };
    ch.messages.push(stored);
    ch.seen.add(p.message_id);

    // deliver to any LIVE subscribers (offline subscribers replay on subscribe)
    const subs = this.subscribers.get(p.channel) ?? [];
    for (const fn of subs) {
      void fn({
        channel: p.channel,
        message_id: stored.message_id,
        payload: stored.payload,
        offset,
      });
    }
    return { enqueued: true, offset };
  }

  async subscribe(
    p: { channel: string; from_offset: number },
    onMessage: (m: ChannelMessage) => void | Promise<void>,
  ): Promise<Subscription> {
    const ch = this.getOrCreate(p.channel);
    // replay: at-least-once from from_offset, skipping already-acked (A2 resume)
    const backlog = ch.messages
      .filter((m) => m.offset >= p.from_offset && !m.acked)
      .sort((a, b) => a.offset - b.offset); // per-channel ordering
    for (const m of backlog) {
      await onMessage({
        channel: p.channel,
        message_id: m.message_id,
        payload: m.payload,
        offset: m.offset,
      });
    }
    const list = this.subscribers.get(p.channel) ?? [];
    list.push(onMessage);
    this.subscribers.set(p.channel, list);
    return {
      unsubscribe: () => {
        const arr = this.subscribers.get(p.channel) ?? [];
        this.subscribers.set(
          p.channel,
          arr.filter((f) => f !== onMessage),
        );
      },
    };
  }

  async ack(p: {
    channel: string;
    message_id: string;
  }): Promise<{ acked: true }> {
    const ch = this.channels.get(p.channel);
    if (!ch)
      throw new McplayerError(
        MCPLAYER_ERR.UNKNOWN_CHANNEL,
        `unknown channel ${p.channel}`,
      );
    const m = ch.messages.find((x) => x.message_id === p.message_id);
    if (m) m.acked = true; // frees WAL capacity; offset integrity preserved
    return { acked: true };
  }

  /** Models mcplayer's durable WAL surviving an mcplayer process restart. */
  snapshot(): McplayerSnapshot {
    const channels: McplayerSnapshot["channels"] = {};
    for (const [name, c] of this.channels) {
      channels[name] = {
        nextOffset: c.nextOffset,
        messages: c.messages.map((m) => ({ ...m })),
      };
    }
    return { channels };
  }

  private getOrCreate(channel: string): ChannelState {
    let ch = this.channels.get(channel);
    if (!ch) {
      ch = { nextOffset: 0, messages: [], seen: new Set() };
      this.channels.set(channel, ch);
    }
    return ch;
  }
}
