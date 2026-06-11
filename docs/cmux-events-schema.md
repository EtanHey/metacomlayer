# `cmux.*` event-family schema — fleet agent lifecycle in the journal (CMX-P5)

> **Status: DRAFT v1 (controllayer-authored, 2026-06-11).** This is the "cli-agents in the ledger" half of Etan's ledger-scope ruling ("the control layer should be more than just models — including cli agents, open apps and such"). **controllayer owns the SCHEMA + the journal-append path (clx); cmuxlayer owns the EMISSION** (the cmux MCP emits these rows on spawn/state/done/kill). **cmuxlayer ratifies + implements when it seats** — this draft exists so cmuxlayer's week-1 clock starts warm. Changes are versioned (bump the header + add a CHANGELOG line).

## Why
Today "who is running, where, doing what, spawned by whom" lives in tribal knowledge + `cmux list_agents` (ephemeral, dies with the daemon). Etan audits it by hand ("you got a monitor on orc?", "the codex has yet to get a boot prompt, no one's working"). Putting agent lifecycle into the append-only journal makes the fleet roster a query (`clx roster` / `clx tail --topic cmux`), survives compaction/restart, and feeds prediction + the morning dashboard. It is the richer, live-emitted sibling of `cli.run` (the perf-taxonomy summary record, already shipped).

## Transport
All `cmux.*` events are appended to the one fleet journal via `clx append cmux <type> <json>` (canonical path: server-stamped `ts`, SQLITE_PATH_CONTAINMENT, append-only). Topic = `cmux`. No new table, no new DB — the spine's `events` table.

## Event types

| type | when | required payload | optional |
|---|---|---|---|
| `cmux.spawn` | a seat/worker pane is created | `agent` (claim name, e.g. `controllayer-w5`), `surface` (`s:120`), `repo`, `role` (`orc`\|`lead`\|`ic`\|`worker`), `cli` (`claude`\|`codex`\|`cursor`\|`gemini`) | `parent_seat`, `model`, `worktree`, `task_label` |
| `cmux.state` | a tracked state transition | `agent`, `surface`, `state` (`ready`\|`working`\|`idle`\|`done`\|`error`) | `context_pct`, `token_count` |
| `cmux.done` | the pane's task completes | `agent`, `surface`, `outcome` (`ok`\|`fail`\|`killed`), `duration_s` | `pr`, `repo`, `merged_commit` |
| `cmux.kill` | a pane is killed/closed | `agent`, `surface`, `reason` | `by_seat` |

### Field semantics
- **`agent`** = the Name-Claim Protocol claim (the `> CLAIM name=` value). Workers = `<seat>-w<N>` (rule 3). This is the join key across all four event types and to `seat.register` (clx-boot gate 3).
- **`surface`** = cmux surface id (`s:NNN`); the live handle. May change if a pane is re-homed — `cmux.state` carries the current one.
- **`parent_seat`** = the lead/orc that spawned this worker → lets `clx roster` render the spawn tree, not a flat list.
- **`outcome`** on `cmux.done` mirrors `cli.run.outcome` (perf-taxonomy) so a `cmux.done{ok,pr}` and the matching `cli.run` reconcile.

## Roster integration
`clx roster` (clx-boot gate 3, already shipped) reads `seat.register` rows. CMX-P5 EXTENDS it: a live roster = latest `cmux.spawn`/`cmux.state` per `agent`, minus those with a later `cmux.done`/`cmux.kill`. Net: `clx roster --live` answers "who is working right now, on what surface, spawned by whom" from the journal alone — the question Etan keeps asking by hand. `monitor_task_id` (from `seat.register`) joins in so the roster also shows who has a monitor (the honesty contract).

## Relationship to existing families (no overlap, clean seams)
- **`cli.run`** (perf-taxonomy, shipped): a single summary record of a CLI-agent invocation. `cmux.done` is the lifecycle terminal; emit BOTH or treat `cmux.done` as the authoritative lifecycle row and `cli.run` as the perf-rollup. Recommendation: `cmux.*` for lifecycle, `cli.run` only when a non-cmux CLI agent runs (no pane).
- **`seat.register`** (clx-boot, shipped): identity + pin assertion at boot. `cmux.spawn` is the pane-creation event; a lead's `clx boot` writes `seat.register`, the cmux MCP writes `cmux.spawn`. They share `agent`.
- **`sys.snapshot`** (perf-taxonomy, shipped): system-wide state; orthogonal.

## Emission contract (cmuxlayer's half — to ratify)
The cmux MCP / engine SHOULD `clx append cmux <type> <json>` at: pane spawn (`cmux.spawn`), each parsed state transition from `read_screen` (`cmux.state`, debounced), pane close/done-signal (`cmux.done`), and kill (`cmux.kill`). Append is fire-and-forget + loud-fail (never block the engine); if the journal is unreachable, log loudly, don't crash the pane. Path-resolution of `clx` via env/launcher indirection (same pattern as the voicelayer hook).

## Open questions for cmuxlayer ratification
1. Debounce policy for `cmux.state` (every transition vs sampled) — avoid journal spam from rapid working/idle flaps.
2. Does the cmux MCP call `clx append` directly (shell) or via a thin in-process binding? (latency vs coupling.)
3. Backfill: emit `cmux.spawn` for already-running panes at MCP boot, or only forward from ratification?

## CHANGELOG
- v1 (2026-06-11) — initial draft, controllayer. Awaiting cmuxlayer ratification.
