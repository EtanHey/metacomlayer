/**
 * MCL presence registry — bus-backed surface over the pure fold (./presence).
 *
 * register/deregister publish a durable event to channel:registry (NEVER acked —
 * it's the event log). listAgents replays that log from offset 0 (a spike proved
 * concurrent replays each get the full backlog) and folds it into the live
 * roster. This is the prerequisite surface for the BrainBar live-agents consumer
 * and MCL-global rollout. Envelope-agnostic: rides the same MCL envelope as the
 * rest of MCL, no new transport.
 */
import { MclClient } from "../client/client";
import { buildMessage } from "../schema/envelope";
import { REGISTRY_CHANNEL } from "../schema/channels";
import {
  foldPresence,
  toPresenceEvent,
  type AgentPresence,
  type PresenceEvent,
} from "./presence";

export interface RegisterInput {
  id: string;
  role?: string;
  capabilities?: string[];
}

export class MclRegistry {
  constructor(private client: MclClient) {}

  /** Announce this agent as live (also a heartbeat — re-register updates last_seen). */
  async register(agent: RegisterInput): Promise<void> {
    await this.client.send(
      buildMessage({
        method: "mcl.register",
        sender: { id: agent.id, role: agent.role ?? "agent" },
        recipient: REGISTRY_CHANNEL,
        thread_id: "registry",
        subject: "register",
        body: JSON.stringify({
          capabilities: agent.capabilities ?? [],
          last_seen: Date.now(),
        }),
        requires_ack: false,
      }),
    );
  }

  /** Announce this agent as gone. */
  async deregister(id: string): Promise<void> {
    await this.client.send(
      buildMessage({
        method: "mcl.deregister",
        sender: { id, role: "agent" },
        recipient: REGISTRY_CHANNEL,
        thread_id: "registry",
        subject: "deregister",
        body: "",
        requires_ack: false,
      }),
    );
  }

  /**
   * Current live roster. Replays the registry log from offset 0 for `windowMs`
   * (no ack — never consume the log) and folds. `staleMs` drops agents whose
   * last_seen is older than now-staleMs (covers a crash with no deregister).
   */
  async listAgents(
    opts: { staleMs?: number; quietMs?: number; maxMs?: number } = {},
  ): Promise<AgentPresence[]> {
    // Adaptive drain: replay from offset 0 and resolve once the backlog goes
    // QUIET (no new event for quietMs) rather than after a fixed window — so a
    // large log fully drains and the roster is never silently truncated. maxMs
    // is a hard ceiling. (Unbounded log growth is bounded by mcplayer WAL
    // compaction; a registry snapshot/compaction is a future optimization.)
    const quietMs = opts.quietMs ?? 250;
    const maxMs = opts.maxMs ?? 5000;
    const events: PresenceEvent[] = [];

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const armQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(resolveDone, quietMs);
    };

    const sub = await this.client.receive(
      REGISTRY_CHANNEL,
      ({ envelope, raw }) => {
        const ev = toPresenceEvent(envelope, raw.offset);
        if (ev) events.push(ev);
        armQuiet(); // each arrival resets the quiet timer → drain keeps going
      },
      0,
    );
    armQuiet(); // empty log → resolve after quietMs
    const cap = setTimeout(resolveDone, maxMs);

    await done;
    clearTimeout(quietTimer);
    clearTimeout(cap);
    sub.unsubscribe();
    return foldPresence(events, { staleMs: opts.staleMs, now: Date.now() });
  }
}
