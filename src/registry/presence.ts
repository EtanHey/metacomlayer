/**
 * MCL presence registry — pure event-sourcing core.
 *
 * Agents publish register/deregister events to channel:registry (the durable,
 * never-acked event log). `foldPresence` replays that log into the current live
 * roster: register adds/updates an agent, deregister removes it, ordered by the
 * bus offset (last-write-wins). A spike confirmed two concurrent from_offset:0
 * subscribers each get the FULL backlog (independent cursors), so any querier
 * can reconstruct the roster without consuming the log.
 */
import type { MclEnvelope } from "../schema/envelope";

export interface PresenceEvent {
  kind: "register" | "deregister";
  /** the agent's id (the event's sender) */
  id: string;
  role?: string;
  capabilities?: string[];
  /** ms-epoch the agent last declared itself present */
  last_seen?: number;
  /** bus offset — fold orders by this, not arrival order */
  offset: number;
}

export interface AgentPresence {
  id: string;
  role?: string;
  capabilities?: string[];
  last_seen?: number;
}

/**
 * Map a replayed registry envelope to a PresenceEvent. register carries
 * {capabilities, last_seen} as a JSON body; deregister has none. A non-registry
 * method returns null so the fold ignores stray traffic on the channel.
 */
export function toPresenceEvent(
  env: MclEnvelope,
  offset: number,
): PresenceEvent | null {
  const kind =
    env.method === "mcl.register"
      ? "register"
      : env.method === "mcl.deregister"
        ? "deregister"
        : null;
  if (!kind) return null;

  const sender = env.params.routing.sender;
  if (kind === "deregister") {
    return { kind, id: sender.id, offset };
  }
  let extra: { capabilities?: string[]; last_seen?: number } = {};
  try {
    const parsed = JSON.parse(env.params.payload.body || "{}");
    if (parsed && typeof parsed === "object") extra = parsed;
  } catch {
    // malformed body → register with id/role only
  }
  return {
    kind,
    id: sender.id,
    role: sender.role,
    capabilities: extra.capabilities,
    last_seen: extra.last_seen,
    offset,
  };
}

/**
 * Fold a register/deregister event log into the current live roster.
 * `staleMs` (with `now`) drops agents whose last_seen is older than now-staleMs
 * — covers a crash that never sent deregister. Roster is sorted by id (stable).
 */
export function foldPresence(
  events: PresenceEvent[],
  opts: { staleMs?: number; now?: number } = {},
): AgentPresence[] {
  const live = new Map<string, AgentPresence>();
  for (const e of [...events].sort((a, b) => a.offset - b.offset)) {
    if (e.kind === "deregister") {
      live.delete(e.id);
    } else {
      live.set(e.id, {
        id: e.id,
        role: e.role,
        capabilities: e.capabilities,
        last_seen: e.last_seen,
      });
    }
  }
  let roster = [...live.values()];
  if (opts.staleMs !== undefined) {
    const now = opts.now ?? Date.now();
    roster = roster.filter(
      (a) => a.last_seen === undefined || now - a.last_seen <= opts.staleMs!,
    );
  }
  return roster.sort((a, b) => a.id.localeCompare(b.id));
}
