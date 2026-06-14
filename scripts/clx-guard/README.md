# clx-guard — heavy-ML memory guardian + single-slot mutex

The control-layer guardrail that **should have caught the 2026-06-14 crash**.

## What happened (why this exists)

On 2026-06-14 the Mac took two **watchdog-timeout kernel panics** (00:59:59 + 01:49:25 —
`last reboot` + the decoded panic Calendar epochs agree). The panic string both times:

```
panic: watchdog timeout: no checkins from watchdogd in 92 seconds
```

That is **memory-exhaustion livelock**: 3× `python3.11` @ ~14 GB + `llama-server` @ 5.5 GB +
`ollama` + `whisper-server` on a **36 GB** box drove the VM compressor to *100 % of segments / 47
swapfiles* (per the panic zone-info). The machine thrashed so hard `watchdogd` couldn't check in
for 92 s, so the kernel hardware watchdog panicked it. (Full diagnosis:
`orchestrator/docs.local/research/2026-06-14-crash-diagnosis.md`.)

The existing `cmux-memory-watchdog` did **not** prevent it, for two structural reasons:
1. It is **cmux-PID-centric** — it watches system compressor but only knows how to *kill cmux*
   (which was 1.4 GB and not the culprit). It is blind to non-cmux ML procs.
2. The `cmux-ram-sampler` **died Jun 11 22:38** and nothing screamed — telemetry went dark with
   no freshness alarm.

## What this adds (collision-free, standalone)

This guard is **separate** from the cmuxlayer watchdog/sampler (which have live uncommitted WIP
from the cmuxlayer lead — we don't clobber another lead's working tree). Once Etan rules the
canonical-copy decision, this logic folds into the canonical watchdog.

### `heavy-ml-guardian.sh` — detection + alert (alert-first)
Runs every 60 s (launchd). Trips on:
- **`heavy_ml_mutex`** — more than one heavy-ML proc resident (`> HEAVY_ML_MUTEX_MAX_SLOTS`).
- **`heavy_ml_aggregate`** — total heavy-ML footprint `> HEAVY_ML_AGG_DANGER_GB` (default 24 GB).
- **`compressor`** — VM compressor `> HEAVY_ML_COMPRESSOR_DANGER_GB` (default 12 GB), computed at
  the **real 16 K page size** (the cmux sampler/watchdog hardcode 4096 → under-report 4×; flagged
  to the cmuxlayer lead).
- **`sampler_stale`** — `cmux-ram-sampler` samples.jsonl older than `HEAVY_ML_SAMPLER_STALE_SECONDS`
  (default 900 s) — the Jun-11 silent-death case.

On a trip: JSON status to stdout (always), Telegram notify, and a `clx emit local.ram.guard` event
(the clx-03 control-layer through-line). **Guarded kill is opt-in** (`HEAVY_ML_GUARD_ENABLE_KILL=1`,
off by default — alert-first per clx-03; TERMs all-but-the-largest on a mutex breach).

A "heavy-ML proc" = command matches `llama-server|ollama|whisper-server|mlx|python` **and** RSS ≥
`HEAVY_ML_MIN_GB` (default 3 GB). cmux / claude / codex / cursor never match.

### `heavy-ml-slot.sh` — the actual MUTEX (prevention, not just detection)
A macOS-portable (no `flock`) single-slot lock so **cooperating launchers serialize** — only one
heavy local-ML job runs at a time. Wrap any heavy ML start:

```sh
heavy-ml-slot.sh with ollama serve
heavy-ml-slot.sh with python infer_mlx.py --model theo
heavy-ml-slot.sh with whisper-server -m models/...
```

A second concurrent `with` exits **75** (back off) instead of piling a second 14 GB proc onto the
box. Dead holders are auto-reclaimed (crash resilience).

## Install

```sh
bash scripts/clx-guard/heavy-ml-guardian.sh          # one-shot, prints JSON status
bun test scripts/clx-guard/heavy-ml-guardian.test.ts # 10 tests

# launchd (60s):
cp scripts/clx-guard/com.golems.heavy-ml-guardian.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.golems.heavy-ml-guardian.plist
```

## Tuning (env / plist EnvironmentVariables)

| var | default | meaning |
|---|---|---|
| `HEAVY_ML_MIN_GB` | 3 | RSS floor to count as a heavy-ML slot |
| `HEAVY_ML_MUTEX_MAX_SLOTS` | 1 | concurrent heavy-ML procs allowed |
| `HEAVY_ML_AGG_DANGER_GB` | 24 | aggregate ML footprint danger |
| `HEAVY_ML_COMPRESSOR_DANGER_GB` | 12 | compressor danger |
| `HEAVY_ML_SAMPLER_STALE_SECONDS` | 900 | sampler freshness window |
| `HEAVY_ML_GUARD_ENABLE_KILL` | 0 | 1 = guarded kill all-but-largest on mutex breach |
| `HEAVY_ML_CLX_CLI` | (unset) | e.g. `bun .../src/clx/cli.ts` to emit `local.ram.guard` events |
