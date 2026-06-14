#!/usr/bin/env bash
# heavy-ml-guardian — whole-system heavy-ML memory guard (clx control layer)
#
# WHY THIS EXISTS: on 2026-06-14 the Mac took two watchdog-timeout KERNEL PANICS
# (00:59:59 + 01:49:25) from memory-exhaustion livelock — 3x python3.11 @ ~14GB +
# llama-server @ 5.5GB on a 36GB box drove the compressor to 100% of segments / 47
# swapfiles, starving watchdogd. The existing cmux-memory-watchdog is cmux-PID-centric:
# it watches system compressor but only knows how to KILL CMUX (which was 1.4GB and not
# the culprit). This guardian closes that blind spot — it watches NON-CMUX heavy-ML procs
# and the sampler's own liveness, and alerts (alert-first; guarded kill is opt-in).
#
# Standalone by design: it does NOT edit the cmuxlayer watchdog/sampler (which have
# live uncommitted WIP from the cmuxlayer lead). Once the canonical-copy decision lands,
# this logic can be folded into the canonical watchdog.
#
# Signals it trips on:
#   heavy_ml_mutex      — more than HEAVY_ML_MUTEX_MAX_SLOTS heavy-ML procs resident
#   heavy_ml_aggregate  — total heavy-ML footprint > HEAVY_ML_AGG_DANGER_GB
#   compressor          — VM compressor > HEAVY_ML_COMPRESSOR_DANGER_GB (real page size)
#   sampler_stale       — cmux-ram-sampler samples.jsonl older than HEAVY_ML_SAMPLER_STALE_SECONDS
#
# Side effects on trip: JSON status to stdout (always), Telegram notify, optional clx
# event emit (HEAVY_ML_CLX_CLI), optional guarded kill (HEAVY_ML_GUARD_ENABLE_KILL=1, off
# by default).
set -euo pipefail

HEAVY_ML_MIN_GB="${HEAVY_ML_MIN_GB:-3}"                       # a proc counts as a heavy-ML slot at/above this RSS
HEAVY_ML_MUTEX_MAX_SLOTS="${HEAVY_ML_MUTEX_MAX_SLOTS:-1}"     # single-heavy-ML-slot mutex
HEAVY_ML_AGG_DANGER_GB="${HEAVY_ML_AGG_DANGER_GB:-24}"        # aggregate ML footprint danger (of 36GB)
HEAVY_ML_COMPRESSOR_DANGER_GB="${HEAVY_ML_COMPRESSOR_DANGER_GB:-12}"
HEAVY_ML_SAMPLE_FILE="${HEAVY_ML_SAMPLE_FILE:-$HOME/Library/Logs/cmux-ram-sampler/samples.jsonl}"
HEAVY_ML_SAMPLER_STALE_SECONDS="${HEAVY_ML_SAMPLER_STALE_SECONDS:-900}"   # sampler runs every 300s; 900s = dead
HEAVY_ML_NOTIFY_URL="${HEAVY_ML_NOTIFY_URL:-http://localhost:3847/notify}"
HEAVY_ML_NOTIFY_SOURCE="${HEAVY_ML_NOTIFY_SOURCE:-alerts}"
HEAVY_ML_NOTIFY_PRIORITY="${HEAVY_ML_NOTIFY_PRIORITY:-high}"
HEAVY_ML_CLX_CLI="${HEAVY_ML_CLX_CLI:-}"                      # e.g. "bun /path/src/clx/cli.ts" — emit local.ram.guard events
HEAVY_ML_GUARD_ENABLE_KILL="${HEAVY_ML_GUARD_ENABLE_KILL:-1}" # 1 = autokill TRUE runaways only (Etan ruling 2026-06-14). 0 = alert-only.
HEAVY_ML_RUNAWAY_GB="${HEAVY_ML_RUNAWAY_GB:-12}"             # a non-seat, non-protected proc at/above this RSS, under danger, is a runaway
HEAVY_ML_KILL_BIN="${HEAVY_ML_KILL_BIN:-kill}"
HEAVY_ML_TERM_GRACE_SECONDS="${HEAVY_ML_TERM_GRACE_SECONDS:-8}"

# NEVER autokill these — day-to-day holders that must "stay booted" (Etan: nothing quits
# unexpectedly). Wispr STT, the voice LLM, ollama, and the embedder daemon are protected.
HEAVY_ML_PROTECTED_PATTERN="${HEAVY_ML_PROTECTED_PATTERN:-whisper-server|mlx_lm\.server|ollama|bge-large|embed}"
# The RAM-seat holder is the ONE legit heavy job and is never killed (read from ram-seat).
RAM_SEAT_HOLD="${RAM_SEAT_HOLD:-${TMPDIR:-/tmp}/ram-seat/holder}"

# Process command must match one of these to count as heavy-ML. python is gated by RSS.
HEAVY_ML_PATTERN="${HEAVY_ML_PATTERN:-llama-server|ollama|whisper-server|[Mm]lx|[Pp]ython}"

log() { printf '[heavy-ml-guardian] %s\n' "$*" >&2; }

ps_source() {
  if [[ -n "${HEAVY_ML_PS_FIXTURE:-}" ]]; then
    cat "$HEAVY_ML_PS_FIXTURE"
  else
    # pid rss(KB) command...
    ps -axo pid=,rss=,command=
  fi
}

now_epoch() { echo "${HEAVY_ML_NOW_EPOCH:-$(date +%s)}"; }

# Returns matched heavy-ML procs as TSV lines: pid<TAB>rss_kb<TAB>shortname
heavy_procs() {
  local min_kb
  min_kb="$(awk -v g="$HEAVY_ML_MIN_GB" 'BEGIN { printf "%.0f", g * 1024 * 1024 }')"
  ps_source | awk -v min_kb="$min_kb" -v pat="$HEAVY_ML_PATTERN" '
    {
      pid = $1; rss = $2;
      cmd = $0;
      sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "", cmd);
      if (rss + 0 >= min_kb && cmd ~ pat) {
        name = cmd; sub(/[[:space:]].*/, "", name);
        printf "%s\t%s\t%s\n", pid, rss, name;
      }
    }'
}

# Real page size from vm_stat header (Apple Silicon is 16384, NOT 4096 — the cmux
# sampler/watchdog hardcode 4096 and under-report compressor 4x).
vmstat_compressor_gb() {
  local out pages pagesize
  if [[ -n "${HEAVY_ML_VMSTAT_FIXTURE:-}" ]]; then
    out="$(cat "$HEAVY_ML_VMSTAT_FIXTURE")"
  else
    out="$(vm_stat 2>/dev/null || true)"
  fi
  pagesize="$(printf '%s\n' "$out" | awk '/page size of/ { for (i=1;i<=NF;i++) if ($i=="of") { print $(i+1); exit } }')"
  pagesize="${pagesize:-16384}"
  pages="$(printf '%s\n' "$out" | awk '/Pages occupied by compressor/ { gsub(/\./,"",$NF); print $NF }')"
  pages="${pages:-0}"
  awk -v p="$pages" -v ps="$pagesize" 'BEGIN { printf "%.2f", p * ps / (1024 * 1024 * 1024) }'
}

# echo 1 if the sampler file has a fresh trailing ts, else 0
sampler_fresh() {
  [[ -f "$HEAVY_ML_SAMPLE_FILE" ]] || { echo 0; return; }
  local last_ts last_epoch now age
  last_ts="$(tail -1 "$HEAVY_ML_SAMPLE_FILE" 2>/dev/null | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p')"
  [[ -n "$last_ts" ]] || { echo 0; return; }
  last_epoch="$(date -j -f '%Y-%m-%dT%H:%M:%S%z' "$last_ts" '+%s' 2>/dev/null || echo 0)"
  now="$(now_epoch)"
  age=$(( now - last_epoch ))
  if (( last_epoch > 0 && age <= HEAVY_ML_SAMPLER_STALE_SECONDS )); then echo 1; else echo 0; fi
}

notify() {
  local tripped="$1" count="$2" total_gb="$3" comp_gb="$4"
  command -v curl >/dev/null 2>&1 || return 0
  jq -cn \
    --arg title "heavy-ml-guardian" \
    --arg body "TRIPPED: $tripped — $count heavy-ML procs, ${total_gb}GB total, compressor ${comp_gb}GB. (alert-only)" \
    --arg source "$HEAVY_ML_NOTIFY_SOURCE" \
    --arg priority "$HEAVY_ML_NOTIFY_PRIORITY" \
    '{title:$title,body:$body,source:$source,priority:$priority}' 2>/dev/null \
    | curl -sS -X POST "$HEAVY_ML_NOTIFY_URL" -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 || true
}

emit_clx() {
  local tripped="$1" count="$2" total_gb="$3" comp_gb="$4"
  [[ -n "$HEAVY_ML_CLX_CLI" ]] || return 0
  local payload
  payload="$(jq -cn --arg t "$tripped" --argjson c "${count:-0}" --arg g "$total_gb" --arg comp "$comp_gb" \
    '{tripped:$t,heavy_ml_count:$c,heavy_ml_total_gb:($g|tonumber),compressor_gb:($comp|tonumber)}' 2>/dev/null)" || return 0
  # shellcheck disable=SC2086
  $HEAVY_ML_CLX_CLI emit local.ram.guard "$payload" >/dev/null 2>&1 || log "clx emit failed (degrading loud): $HEAVY_ML_CLX_CLI"
}

seat_holder_pid() { cat "$RAM_SEAT_HOLD/pid" 2>/dev/null || true; }

# Autokill TRUE RUNAWAYS ONLY (Etan: autokill yes, but never legit work, never an
# unexpected quit). A runaway = a heavy-ML proc that is ALL of:
#   - at/above HEAVY_ML_RUNAWAY_GB (pathologically large), AND
#   - NOT on the protected list (Wispr/voice/ollama/embedder stay booted), AND
#   - NOT the RAM-seat holder (the one legit heavy job), AND
#   - the system is in REAL danger (compressor or aggregate over threshold — passed in).
# Legit work that uses the seat, and day-to-day holders, are NEVER touched. Every kill is
# announced (Telegram + clx) — never silent.
autokill_runaways() {
  local runaway_kb seat_pid cand pid rss name gb survivors=""
  runaway_kb="$(awk -v g="$HEAVY_ML_RUNAWAY_GB" 'BEGIN { printf "%.0f", g * 1024 * 1024 }')"
  seat_pid="$(seat_holder_pid)"
  cand="$(ps_source | awk -v min="$runaway_kb" -v pat="$HEAVY_ML_PATTERN" -v prot="$HEAVY_ML_PROTECTED_PATTERN" -v seat="${seat_pid:-0}" '
    {
      pid = $1; rss = $2; cmd = $0;
      sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "", cmd);
      if (rss + 0 >= min && cmd ~ pat && cmd !~ prot && pid != seat) {
        name = cmd; sub(/[[:space:]].*/, "", name);
        printf "%s\t%s\t%s\n", pid, rss, name;
      }
    }')"
  if [[ -z "$cand" ]]; then
    log "danger but NO true runaway — every heavy proc is protected or the seat holder. Alert-only, nothing killed (never an unexpected quit)."
    return 0
  fi
  while IFS=$'\t' read -r pid rss name; do
    [[ -n "$pid" ]] || continue
    gb="$(awk -v k="$rss" 'BEGIN { printf "%.1f", k / 1048576 }')"
    log "AUTOKILL runaway pid=$pid name=$name rss=${gb}GB (>=${HEAVY_ML_RUNAWAY_GB}GB, non-protected, non-seat, system in danger) — TERM"
    notify "autokill-runaway:$name(${gb}GB)" "1" "$gb" "$(vmstat_compressor_gb)"
    emit_clx "autokill_runaway:pid$pid:$name:${gb}GB" "1" "$gb" "0"
    "$HEAVY_ML_KILL_BIN" -TERM "$pid" 2>/dev/null || true
    survivors="${survivors}${pid} "
  done <<<"$cand"
  # grace, then KILL any that ignored TERM
  sleep "$HEAVY_ML_TERM_GRACE_SECONDS"
  for pid in $survivors; do
    if "$HEAVY_ML_KILL_BIN" -0 "$pid" 2>/dev/null; then
      log "AUTOKILL pid=$pid survived TERM — KILL"
      "$HEAVY_ML_KILL_BIN" -KILL "$pid" 2>/dev/null || true
    fi
  done
}

run_once() {
  local ts procs count total_kb total_gb fresh comp_gb tripped=""
  ts="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  procs="$(heavy_procs || true)"
  count="$(printf '%s' "$procs" | awk 'NF' | wc -l | tr -d ' ')"
  total_kb="$(printf '%s\n' "$procs" | awk -F'\t' '{ s += $2 } END { printf "%.0f", s + 0 }')"
  total_gb="$(awk -v k="${total_kb:-0}" 'BEGIN { printf "%.2f", k / (1024 * 1024) }')"
  fresh="$(sampler_fresh)"
  comp_gb="$(vmstat_compressor_gb)"

  (( count > HEAVY_ML_MUTEX_MAX_SLOTS )) && tripped="${tripped}${tripped:+,}heavy_ml_mutex"
  awk -v a="$total_gb" -v d="$HEAVY_ML_AGG_DANGER_GB" 'BEGIN { exit !(a > d) }' && tripped="${tripped}${tripped:+,}heavy_ml_aggregate"
  awk -v c="$comp_gb" -v d="$HEAVY_ML_COMPRESSOR_DANGER_GB" 'BEGIN { exit !(c > d) }' && tripped="${tripped}${tripped:+,}compressor"
  [[ "$fresh" == "1" ]] || tripped="${tripped}${tripped:+,}sampler_stale"

  printf '{"ts":"%s","heavy_ml_count":%s,"heavy_ml_total_gb":%s,"sampler_fresh":%s,"compressor_gb":%s,"tripped":"%s"}\n' \
    "$ts" "${count:-0}" "${total_gb:-0}" "${fresh:-0}" "${comp_gb:-0}" "$tripped"

  if [[ -n "$tripped" ]]; then
    log "TRIPPED: $tripped (heavy_ml_count=$count total=${total_gb}GB compressor=${comp_gb}GB sampler_fresh=$fresh)"
    [[ -n "$procs" ]] && { log "heavy-ML procs (pid/rss_kb/name):"; printf '%s\n' "$procs" >&2; }
    notify "$tripped" "$count" "$total_gb" "$comp_gb"
    emit_clx "$tripped" "$count" "$total_gb" "$comp_gb"
    # Autokill ONLY under REAL memory danger (compressor or aggregate over threshold) — never
    # on a bare mutex/stale signal. And only TRUE runaways (autokill_runaways protects legit
    # work + the seat holder + day-to-day daemons).
    if [[ "$HEAVY_ML_GUARD_ENABLE_KILL" == "1" && ( "$tripped" == *compressor* || "$tripped" == *heavy_ml_aggregate* ) ]]; then
      autokill_runaways
    fi
  fi
}

if [[ "${HEAVY_ML_GUARDIAN_SOURCE_ONLY:-0}" != "1" ]]; then
  run_once
fi
