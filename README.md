# metacomlayer (MCL)

> **MCL = the Meta-Communication Layer** — the inter-agent message bus (envelope · per-vendor adapters · channels · delivery receipts) that **STACKS ON** the [`mcplayer`](https://github.com/EtanHey/mcplayer) transport. MCL builds **no broker**: durability (WAL, at-least-once, per-channel ordering) is `mcplayer`'s. Package prefix stays `mcl-*`; the repo is `metacomlayer`.

Replaces the brittle "inject text into another agent's terminal stdin" hack with a real async bus + **verifiable delivery receipts** (kills fake-delivery). Targets Claude Code, OpenAI Codex CLI, and Cursor CLI running in adjacent panes.

## Status — P1 + P2 (GREEN), built against the locked mcplayer contract
| Module → package | What | Tests |
|------------------|------|-------|
| `src/schema/` → **mcl-schema** | canonical JSON-RPC 2.0 envelope: routing + A2A headers + payload + delivery_control; Request(has id)/Notification(no id) discipline; build / serialize(NDJSON) / parse | 4 ✅ |
| `src/client/` → **mcl-client** | the 5-method `mcplayer` interface contract, an in-memory two-plane `MockMcplayer`, and `MclClient` (channel routing + schema-validated receive + BUSY-nack handling) | 6 ✅ |

```sh
bun install
bun test        # 10 pass
bun run typecheck
```

## The MCL↔mcplayer seam (LOCKED, co-signed by the mcplayer track)
`mcplayer` exposes a UDS / NDJSON / JSON-RPC 2.0 endpoint; MCL consumes exactly 5 methods — `connect`, `publish`, `subscribe`, `ack`, `status`. `mcplayer` owns the durable queue (WAL + at-least-once + per-channel ordering). MCL builds against `MockMcplayer`; swapping to the real `mcplayer` is a **zero-MCL-change** drop-in (same 5 methods). Amendments locked: two-plane stability (connect/status independent of the queue), bounded-WAL BUSY-nack (`-32004`, never a silent drop), monotonic offsets resumable across an `mcplayer` restart.

## Roadmap
- **P3 `mcl-adapters`** — `claude/channel` MCP, Codex app-server WS, Cursor headless `--resume` stdout capture.
- **P4 `mcl-receipts`** — SHIP-3 3-stage verifiable-delivery ACK state machine + DLQ + ambient status banner.

## Security
Public, but every PR is gated: branch protection + CI (`test`) + AI reviewers. UDS-only transport (no bound network ports), Zod-validated typed boundary, namespace identity rewriting against impersonation.
