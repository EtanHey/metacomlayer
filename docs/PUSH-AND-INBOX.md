# MCL push delivery + the private-inbox primitive

> How agents receive messages over MCL **on arrival, without busy-polling** — and the channel conventions every layer stacking on mcplayer must follow.

## The hard constraint: mcplayer is competing-consumer

mcplayer delivers each message on a channel to **whichever subscriber consumes it first** — it does **not** fan out. Two consequences, both learned the hard way in the first live 2-agent demo:

1. **Never use a shared channel for directed messages.** If agent-A publishes to `channel:demo` and both agent-B and some other consumer subscribe, the other consumer can steal A's message — B never sees it.
2. **Never use a shared channel for receipts.** A SHIP-3 ack on a global `channel:receipts` is delivered to whichever consumer polls first; the original sender often never sees its own receipt and never reaches VERIFIED.

## The primitive: per-agent private channels

Each agent owns two private channels (only that agent — or its out-of-band adapter — consumes them):

| Channel | Convention | Who reads it | Purpose |
|---------|-----------|--------------|---------|
| **inbox** | `channel:inbox:<agentId>` | only `<agentId>` (or its out-of-band adapter) | directed messages TO this agent |
| **ack** | `channel:ack:<agentId>` | only `<agentId>` | SHIP-3 receipts for messages this agent SENT |

A sender stamps `headers.reply_to = channel:ack:<sender>` on every `requires_ack` message; the receiver sends its ack to that `reply_to`. `mcl_publish` returns the `receipt_channel` so the sender knows where to confirm delivery. **Directed messaging never touches a shared channel → no contention.**

## Receiving: event-driven, no busy-loop

`mcl_poll` is an **event-driven long-poll**, not a retry loop:

- It subscribes once; the bus **pushes** `mcplayer.message` notifications over the socket.
- If the inbox is empty, poll **blocks on a promise** that the push handler resolves the **instant** a message lands (or after `wait_ms`, default 30s). No polling interval, no CPU spin.
- **Agents call `mcl_poll` once and wait** — they must NOT loop it. The tool description says so.

## True async push: OUT-OF-BAND, channels-per-harness

LLM agents are request/response — they can't be interrupted mid-thought. "Push" therefore means: the bus delivers on arrival (event-driven, above) **and** the vendor adapter surfaces the message **out-of-band** — as a channel/sidebar event the harness renders, **never** typed into the agent's input line.

> ⛔ **Rejected mechanism (do not revive):** an earlier `scripts/mcl-push-daemon.ts` "pushed" via `cmux send` / `send-key`, typing the message into the agent's TUI input line (`❯`). That is the exact stdin/PTY keystroke-injection anti-pattern MCL exists to replace — it's in-band and interrupts the prompt. A 5-message burst proved it broken (out of order, concatenated). The file is quarantined under `scripts/experimental/` with a BROKEN banner, kept only as reference for the bus-side wiring (subscribe → ack → reply_to receipt). **Do not ship any input-line injection.**

**The standard:** agents communicate over CHANNELS; each harness uses its NATIVE turn-boundary mechanism, but all messages are standardized on one MCL envelope (one format + per-vendor adapters):

| Harness | Native channel | Adapter | Status |
|---------|----------------|---------|--------|
| **Claude Code** | **Stop hook** → `{"decision":"block","reason":<message>}` feeds the message into the agent's NEXT turn, out-of-band | `src/adapters/claude/stop-hook.ts` | ✅ verified live |
| Codex | `app-server` turn-boundary equivalent | _(planned)_ | |
| Cursor / Gemini | vendor turn-boundary equivalent | _(planned)_ | |

### Claude Code: the Stop-hook push (the verified mechanism)

A request/response LLM can't be interrupted mid-thought, so the only place to hand it a message out-of-band is the **turn boundary**. Claude Code's **Stop hook** runs there. The MCL drainer (`stop-hook.ts`) is wired as that hook; on each turn boundary it:

1. drains the agent's private inbox `channel:inbox:<agentId>` straight off the mcplayer bus (`from_offset:0` replays un-acked backlog);
2. sends the SHIP-3 receipt to each message's `reply_to` (so the sender reaches VERIFIED) and acks the bus message so it isn't re-delivered;
3. if mail was waiting, prints `{"decision":"block","reason":"📨 MCL inbox push …"}` → Claude does **not** stop; it feeds `reason` into the agent's next turn. The agent acts on a message it **never polled for**, and the text **never touches the input line**.
4. **Burst-safe:** messages are delivered **oldest-first by offset**, batched into one hand-off (fixes the reorder/concat bug the rejected daemon hit).
5. **Fail-safe:** bus unreachable or misconfigured → the hook allows the stop; the agent never wedges. **At-least-once:** a message is acked only after it's been handed off.

Wire it as a per-agent Stop hook in the agent's `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ {
        "type": "command",
        "command": "MCPLAYER_SOCKET=/tmp/mcplayer-bus.sock MCL_AGENT_ID=<agentId> bun /ABS/PATH/metacomlayer/src/adapters/claude/stop-hook.ts"
      } ] }
    ]
  }
}
```

(`MCL_AGENT_ID` = this agent's id; `MCPLAYER_SOCKET` = the bus; optional `MCL_DRAIN_MS`, default 700, is the backlog-replay window.) A copy-paste template lives at `docs/examples/claude-stop-hook.settings.json`.

> **Future option (not shipped):** Claude Code may later expose a native `claude/channel` MCP notification (`notifications/claude/channel`, cf. cmuxlayer PR #8). On Claude Code 2.1.157 there is **no `--channels`** and the experimental capability does not reach the agent's turn, so the Stop hook is the channel today. The `ClaudeChannelMessage` shape in `src/adapters/translate.ts` is kept for that future only. We ship **one** Claude delivery channel — the Stop hook.

This still reuses the durable mcplayer bus + per-agent private channels; nothing new is invented.

## For other layers (BrainLayer, VoiceLayer) stacking on mcplayer

Use per-recipient inbox channels + per-sender ack channels. Never a shared channel for directed traffic. Reuse `channel:inbox:<id>` / `channel:ack:<id>`, and surface arrivals out-of-band via the harness's native channel adapter (never input-line injection).
