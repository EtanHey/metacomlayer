# MCL push delivery + the private-inbox primitive

> How agents receive messages over MCL **on arrival, without busy-polling** — and the channel conventions every layer stacking on mcplayer must follow.

## The hard constraint: mcplayer is competing-consumer

mcplayer delivers each message on a channel to **whichever subscriber consumes it first** — it does **not** fan out. Two consequences, both learned the hard way in the first live 2-agent demo:

1. **Never use a shared channel for directed messages.** If agent-A publishes to `channel:demo` and both agent-B and some other consumer subscribe, the other consumer can steal A's message — B never sees it.
2. **Never use a shared channel for receipts.** A SHIP-3 ack on a global `channel:receipts` is delivered to whichever consumer polls first; the original sender often never sees its own receipt and never reaches VERIFIED.

## The primitive: per-agent private channels

Each agent owns two private channels (only that agent — or its push daemon — consumes them):

| Channel | Convention | Who reads it | Purpose |
|---------|-----------|--------------|---------|
| **inbox** | `channel:inbox:<agentId>` | only `<agentId>` (or its push daemon) | directed messages TO this agent |
| **ack** | `channel:ack:<agentId>` | only `<agentId>` | SHIP-3 receipts for messages this agent SENT |

A sender stamps `headers.reply_to = channel:ack:<sender>` on every `requires_ack` message; the receiver sends its ack to that `reply_to`. `mcl_publish` returns the `receipt_channel` so the sender knows where to confirm delivery. **Directed messaging never touches a shared channel → no contention.**

## Receiving: event-driven, no busy-loop

`mcl_poll` is an **event-driven long-poll**, not a retry loop:

- It subscribes once; the bus **pushes** `mcplayer.message` notifications over the socket.
- If the inbox is empty, poll **blocks on a promise** that the push handler resolves the **instant** a message lands (or after `wait_ms`, default 30s). No polling interval, no CPU spin.
- **Agents call `mcl_poll` once and wait** — they must NOT loop it. The tool description says so.

## True async push: the injection daemon

LLM agents are request/response — they can't be interrupted mid-thought. So "push" = event-driven delivery **+ adapter-side injection**: a daemon owns the agent's inbox subscription and, on arrival, **injects** the message into the agent's session so it's *handed* the message instead of asking for it.

```sh
MCPLAYER_SOCKET=/tmp/mcplayer-bus.sock bun scripts/mcl-push-daemon.ts <agentId> <surface>
# e.g. … agent-a surface:154
```

- Subscribes to `channel:inbox:<agentId>` (event-driven). The agent itself never polls.
- On each message: `cmux send --surface <surface> "[MCL push] …"` + `send-key return` → the message appears in the agent's pane and it reacts.
- **At-least-once:** only acks + sends the receipt when injection **succeeds** (cmux exit 0). If the surface is dead, it leaves the message UNacked for redelivery — never a silent drop.
- Transport stays the durable mcplayer bus; injection is only the last-mile render.

**Verified on the real bus:** a message published to `channel:inbox:agent-a` was injected into the live agent-A pane; agent-A received it with no `mcl_poll` call and replied via its MCL tools.

## For other layers (BrainLayer, VoiceLayer) stacking on mcplayer

Use per-recipient inbox channels + per-sender ack channels. Never a shared channel for directed traffic. Reuse `channel:inbox:<id>` / `channel:ack:<id>` (or run a push daemon per consumer).
