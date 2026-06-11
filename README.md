# metacomlayer (MCL)

> **MCL = the Meta-Communication Layer** — the inter-agent message bus (envelope · per-vendor adapters · channels · delivery receipts) that **STACKS ON** the [`mcplayer`](https://github.com/EtanHey/mcplayer) transport. MCL builds **no broker**: durability (WAL, at-least-once, per-channel ordering) is `mcplayer`'s. Package prefix stays `mcl-*`; the repo is `metacomlayer`.

Replaces the brittle "inject text into another agent's terminal stdin" hack with a real async bus + **verifiable delivery receipts** (kills fake-delivery). Targets Claude Code, OpenAI Codex CLI, and Cursor CLI running in adjacent panes.

## Status — GREEN on the REAL `mcplayer` bus (push + registry shipped)
| Module → package | What | |
|------------------|------|--|
| `src/schema/` → **mcl-schema** | canonical JSON-RPC 2.0 envelope: routing + A2A headers + payload + delivery_control; Request/Notification discipline; build / serialize(NDJSON) / parse | ✅ |
| `src/client/` → **mcl-client** | the 5-method `mcplayer` interface; in-memory two-plane `MockMcplayer`; `MclClient`; and **`RealMcplayer`** — the zero-MCL-change UDS/NDJSON drop-in (live-bus conformance-tested) | ✅ |
| `src/mcp/` → **mcl MCP server** | stdio MCP adapter so a REAL agent uses MCL as tools: `mcl_publish` / `mcl_poll` (event-driven long-poll) / `mcl_ack` / `mcl_status` / `mcl_register` / `mcl_deregister` / `mcl_agents`. Private per-agent inbox + `reply_to` receipt routing (competing-consumer safe) | ✅ |
| **Claude push** (`src/adapters/claude/stop-hook.ts`) | out-of-band delivery via a **Stop hook** (`{decision:block,reason}`) — the message enters the agent's next turn, never the input line, no polling. Verified live | ✅ |
| `src/registry/` → **mcl-registry** | event-sourced presence over `channel:registry`: `register`/`deregister`, `listAgents` (pull) + `watchAgents` (live push); see `docs/REGISTRY.md` | ✅ |
| `src/adapters/` → **mcl-adapters** | `VendorAdapter` contract + `AdapterRegistry`; pure envelope↔vendor translation; `LoopbackAdapter`. (Codex app-server / Cursor live wiring pending) | ✅ |
| `src/receipts/` → **mcl-receipts** | SHIP-3 verifiable-delivery state machine (VERIFIED only after ACK from ALL owners) + DLQ + negative-ack + ambient banner hook | ✅ |

```sh
bun install
bun test          # 50 pass
bun run typecheck # 0 errors
# live-bus proofs (need a running mcplayer on $MCPLAYER_SOCKET):
bun scripts/verify-mcl-tools.ts    # A→B delivery + SHIP-3 receipt
bun scripts/verify-stop-hook.ts    # out-of-band Stop-hook push (5/5)
bun scripts/verify-registry.ts     # register → roster → deregister
bun scripts/verify-mcp-server.ts   # all 7 MCP tools over stdio
```

Delivery is real, not "bytes queued": SHIP-3 reaches **VERIFIED** only after the recipient ACKs to the sender's private `channel:ack:<id>`. Push (`docs/PUSH-AND-INBOX.md`) and presence (`docs/REGISTRY.md`) ride the same envelope — no new transport.

## Pass-3 local runner

`scripts/pass3-runner.sh` runs the gated Pass-3 graphify job in checkpointed Ollama batches. Each batch is wrapped by `bun run stamp-perf run`, so the journal receives one `local.perf` row with the actual model, duration, memory pressure, swap, and resident model process snapshot.

```sh
# Acceptance proof: exactly one real tiny Ollama batch, then stop.
bash scripts/pass3-runner.sh --dry-run

# Resume proof: the same dry-run skips the checkpointed cmuxlayer:1 batch.
bash scripts/pass3-runner.sh --dry-run

# Abort-path proof: journals pass3.aborted and exits non-zero before inference.
PASS3_MEMORY_THRESHOLD=100 bash scripts/pass3-runner.sh --dry-run
echo $? # 75
```

Defaults target `cmuxlayer` first, followed by the local ecosystem repo list under `$HOME/Gits`; set `PASS3_REPO_ROOT` or pass `--repo/--repos` for another checkout root. `PASS3_MEMORY_THRESHOLD` is a minimum free-memory percentage: if `memory_pressure` reports free memory below the threshold, the runner writes a `perf/pass3.aborted` journal row and exits 75 before inference. Full runs are intentionally only fired by omitting `--dry-run`; the script keeps `OLLAMA_KEEP_ALIVE=0` for wrapped calls and writes checkpoints to `~/.local/share/orc/pass3-checkpoint.json` unless `--checkpoint` or `PASS3_CHECKPOINT` is set.

## The MCL↔mcplayer seam (LOCKED, co-signed by the mcplayer track)
`mcplayer` exposes a UDS / NDJSON / JSON-RPC 2.0 endpoint; MCL consumes exactly 5 methods — `connect`, `publish`, `subscribe`, `ack`, `status`. `mcplayer` owns the durable queue (WAL + at-least-once + per-channel ordering). MCL builds against `MockMcplayer`; swapping to the real `mcplayer` is a **zero-MCL-change** drop-in (same 5 methods). Amendments locked: two-plane stability (connect/status independent of the queue), bounded-WAL BUSY-nack (`-32004`, never a silent drop), monotonic offsets resumable across an `mcplayer` restart.

## Roadmap
- ✅ **Live wiring** — `RealMcplayer` drop-in on the real `mcplayer` bus (zero-MCL-change).
- ✅ **Claude out-of-band push** — Stop-hook adapter, verified live (no input-line injection).
- ✅ **Presence registry** — register/deregister + live-agent roster (pull + push).
- **Codex / Cursor push adapters** — their turn-boundary/hook equivalents on the same MCL envelope (pending the cross-vendor envelope-standard decision).
- **First consumer** — BrainBar live-agents detector, against `mcl_agents` / `channel:registry` (see `docs/REGISTRY.md`); cross-track with BrainLayer.
- **MCL-global rollout** — adopt MCL across the agent fleet (all prerequisite gates met).

## Security
Public, but every PR is gated: branch protection + CI (`test`) + AI reviewers. UDS-only transport (no bound network ports), Zod-validated typed boundary, namespace identity rewriting against impersonation.
