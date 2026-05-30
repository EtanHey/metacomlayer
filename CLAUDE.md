# metacomlayer (MCL) — Repo Context

> **MCL = the Meta-Communication Layer** — the agent-to-agent messaging layer. It rides **ON TOP OF** the `mcplayer` durable bus (`/tmp/mcplayer-bus.sock`); MCL builds **no broker** — durability (WAL, at-least-once, per-channel ordering) is `mcplayer`'s job.

Replaces the brittle "inject text into another agent's terminal stdin" hack with a real async bus plus verifiable delivery receipts. Targets Claude Code, OpenAI Codex CLI, and Cursor CLI in adjacent panes.

## Hard rules for this repo

1. **Push must be OUT-OF-BAND channels, NOT input-injection.** Never inject text into another agent's terminal stdin. Delivery goes over the channel/inbox, never the prompt.
2. **No broker here.** Durability lives in `mcplayer`. MCL consumes its 5-method interface (`connect`, `publish`, `subscribe`, `ack`, `status`) and nothing more.
3. **UDS-only transport.** No bound network ports. Zod-validated typed boundary; namespace identity rewriting against impersonation.
4. **PR Loop.** Every change goes through a PR. No direct commits to `master`. See `/pr-loop`.
5. **TDD.** Failing test first, then implement. See `/superpowers:test-driven-development`.

## Architecture

- **Channels-per-harness** — each vendor gets its own channel adapter:
  - Claude → channel MCP
  - Codex → app-server
  - Cursor → stream-json
- **SHIP-3 receipts** — verifiable-delivery state machine (`enqueued → heads_up → verified`); VERIFIED only after ACK from all owners. DLQ + negative-ack.
- **Per-recipient private-inbox** — `channel:inbox:<id>` for messages + `channel:ack:<id>` for receipts (sender's private ack channel).

## The MCL ↔ mcplayer seam (LOCKED)

`mcplayer` exposes a UDS / NDJSON / JSON-RPC 2.0 endpoint on `/tmp/mcplayer-bus.sock`. MCL consumes exactly 5 methods. Swapping `MockMcplayer` for the real `mcplayer` is a zero-MCL-change drop-in.

## Relation to other *layer repos

- `~/Gits/mcplayer/` — the durable transport MCL stacks on. MCL adds messaging semantics; mcplayer owns the queue.
- `~/Gits/brainlayer/` — memory MCP. First consumer: BrainBar live-agents detector reads the channel/agent registry.
- `~/Gits/cmuxlayer/` — terminal/agent management; cmux A2A smoke is the P3 integration acceptance.

## Skills to invoke

- Creating a PR: `/pr-loop`
- Writing code: `/superpowers:test-driven-development`
- Claiming "done": `/superpowers:verification-before-completion`
- Dispatching agents: `/cmux-agents`
