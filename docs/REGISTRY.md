# MCL presence registry — who's live

> How agents announce presence and discover each other over MCL. The prerequisite
> surface for the BrainBar live-agents consumer and MCL-global rollout.

## Model: event-sourced presence

There is no central registry service — presence rides the same durable mcplayer
bus as everything else. Agents publish **register** / **deregister** events to one
well-known channel, and the live roster is the *fold* of that event log:

| Concept | Detail |
|---------|--------|
| Channel | `channel:registry` (shared, well-known) |
| register | `mcl.register` envelope; body carries `{capabilities, last_seen}`, sender = the agent |
| deregister | `mcl.deregister` envelope; sender = the agent |
| roster | replay `channel:registry` from offset 0 → fold (register adds/updates, deregister removes, last-write-wins by offset) |

The events are **never acked** — the channel is the durable event log, not a work
queue. A spike confirmed that two concurrent `from_offset:0` subscribers each
receive the **full** backlog (independent cursors), so any number of queriers can
reconstruct the roster without consuming it (mcplayer's competing-consumer
behavior applies only to *live, acked* delivery — see `docs/PUSH-AND-INBOX.md`).

## API

`src/registry/registry.ts` — `MclRegistry(client)`:
- `register({ id, role?, capabilities? })` — announce live (also a **heartbeat**: re-calling refreshes `last_seen`).
- `deregister(id)` — announce gone.
- `listAgents({ staleMs?, quietMs?, maxMs? })` — **pull** the current roster. Drains the log adaptively (resolves after a quiet gap, hard-capped) so a large backlog is never truncated. `staleMs` drops agents whose `last_seen` is older than `now - staleMs`.
- `watchAgents(onChange, { staleMs? })` — **push** the live roster: `onChange(roster)` fires on each register/deregister (and once per replayed backlog event on attach). Returns `{ stop() }`. For a TS consumer that wants a live stream instead of polling.

**Language-agnostic consumers** (e.g. Swift/Python BrainBar) don't need the TS helper — subscribe `channel:registry` `from_offset:0` and apply the same fold: register adds/updates by sender id, deregister removes, last-write-wins by offset. Never ack.

`src/registry/presence.ts` — the pure core: `foldPresence(events, { staleMs?, now? })` and `toPresenceEvent(envelope, offset)`. Fully unit-tested.

## MCP tools (agents self-serve)

The MCP server (`src/mcp/server.ts`) exposes:
- **`mcl_register`** — `{ role?, capabilities? }`; registers your `MCL_AGENT_ID`. Call on startup; re-call to heartbeat.
- **`mcl_deregister`** — registers your departure. Call on graceful shutdown.
- **`mcl_agents`** — `{ stale_ms? }`; returns the live roster (`id`, `role`, `capabilities`, `last_seen`). Discover who's online before messaging them.

## Verified

- Pure fold + envelope mapping: `src/registry/presence.test.ts` (unit).
- Live bus: `bun scripts/verify-registry.ts` (register → roster, role/capabilities carried, deregister removes, peer survives).
- Through the MCP server over stdio: `bun scripts/verify-mcp-server.ts` (all 7 tools; `mcl_register` → `mcl_agents` shows self in the roster).

## Notes / future

- `listAgents` drains the log adaptively (resolves after a quiet gap with no new
  events, hard-capped) so a large backlog is never silently truncated.
- The registry log grows with every register/deregister; mcplayer WAL compaction
  bounds it. Heartbeat + `staleMs` give liveness without per-event cleanup.
- Codex / Cursor register over the same envelope via their own MCL adapters.
