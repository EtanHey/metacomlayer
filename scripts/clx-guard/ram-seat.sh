#!/usr/bin/env bash
# ram-seat — sequential seat for heavy jobs: ONE heavy job runs at a time, FIFO queue.
#
# Etan's rule (2026-06-14): "Control layer needs to do the best while not breaking things
# ever. I don't want anything quitting on me unexpectedly. But I also want them to keep
# working." So: heavy BATCH jobs (re-embed, MLX eval, training probe) run SEQUENTIALLY
# through this seat — they WAIT in line instead of piling up and panicking the box.
# Day-to-day holders (embedder daemon, voice STT/LLM, Wispr) do NOT use this — they stay
# booted; this is only for transient heavy jobs that opt in:
#
#   ram-seat.sh run reembed -- python reembed_backfill.py --all
#   ram-seat.sh run mlx-eval -- python eval.py
#   ram-seat.sh status            # who holds the seat + queue depth
#   ram-seat.sh list              # queued tickets
#
# Blocks (FIFO) until it's this job's turn AND the seat is free, then runs the command,
# then releases. Dead holders/tickets are auto-reclaimed (crash resilience — a crashed
# job never wedges the queue). The guardian treats the current seat holder as LEGIT and
# never autokills it; anything heavy that skips the seat is a runaway candidate.
set -euo pipefail

# FIXED absolute path (NOT TMPDIR) so the launchd guardian and an interactive shell ALWAYS
# resolve the same seat — a TMPDIR mismatch would make the guardian blind to the seat and risk
# killing the seated legit job. Keep this in sync with heavy-ml-guardian.sh's RAM_SEAT_HOLD.
RAM_SEAT_DIR="${RAM_SEAT_DIR:-$HOME/.local/state/clx-guard/ram-seat}"
RAM_SEAT_HOLD="$RAM_SEAT_DIR/holder"          # mkdir lock == the one seat
RAM_SEAT_QUEUE="$RAM_SEAT_DIR/queue"          # ticket files, lexically ordered = FIFO
RAM_SEAT_SEQLOCK="$RAM_SEAT_DIR/seq.lock"     # brief lock to allocate a ticket number
RAM_SEAT_SEQ="$RAM_SEAT_DIR/seq"
RAM_SEAT_WAIT_SECONDS="${RAM_SEAT_WAIT_SECONDS:-3600}"  # max time to wait in line
RAM_SEAT_POLL="${RAM_SEAT_POLL:-2}"

# globals for the EXIT-trap cleanup (locals would be out of scope by then)
_RS_TICKET=""
_RS_CHILD=""

log() { printf '[ram-seat] %s\n' "$*" >&2; }

_ensure() { mkdir -p "$RAM_SEAT_QUEUE"; [[ -f "$RAM_SEAT_SEQ" ]] || echo 0 >"$RAM_SEAT_SEQ"; }

_alloc_ticket() {
  local n waited=0 reclaimed=0
  while ! mkdir "$RAM_SEAT_SEQLOCK" 2>/dev/null; do
    sleep 0.1; waited=$((waited + 1))
    # Reclaim a wedged seq lock ONCE (not every iteration — repeatedly rm'ing could delete a
    # fresh holder's lock mid-allocation and hand two allocators the same ticket number).
    if (( waited > 100 && reclaimed == 0 )); then rm -rf "$RAM_SEAT_SEQLOCK"; reclaimed=1; fi
  done
  n="$(cat "$RAM_SEAT_SEQ" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" >"$RAM_SEAT_SEQ"
  rmdir "$RAM_SEAT_SEQLOCK" 2>/dev/null || true
  printf '%012d' "$n"
}

_reap_dead() {
  # NOTE: use if-conditions (exempt from set -e) so a LIVE holder/ticket — i.e. a false
  # `! kill -0` — does not make this function return non-zero and abort the caller.
  local f pid
  shopt -s nullglob
  for f in "$RAM_SEAT_QUEUE"/*; do
    pid="$(sed -n 's/^pid=//p' "$f" 2>/dev/null | head -1)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$f"
    fi
  done
  shopt -u nullglob
  if [[ -f "$RAM_SEAT_HOLD/pid" ]]; then
    pid="$(cat "$RAM_SEAT_HOLD/pid" 2>/dev/null || echo)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      log "reclaiming seat from dead holder $pid"
      rm -rf "$RAM_SEAT_HOLD"
    fi
  fi
  return 0
}

_head() { ls "$RAM_SEAT_QUEUE" 2>/dev/null | sort | head -1; }

_cleanup() {
  [[ -n "$_RS_TICKET" ]] && rm -f "$RAM_SEAT_QUEUE/$_RS_TICKET" 2>/dev/null || true
  # forward a signal to the workload so it doesn't orphan if the wrapper is killed
  [[ -n "$_RS_CHILD" ]] && kill -0 "$_RS_CHILD" 2>/dev/null && kill -TERM "$_RS_CHILD" 2>/dev/null || true
  # only the WRAPPER that owns the seat removes it (holder/pid is now the workload pid)
  if [[ -f "$RAM_SEAT_HOLD/owner" && "$(cat "$RAM_SEAT_HOLD/owner" 2>/dev/null)" == "$$" ]]; then
    rm -rf "$RAM_SEAT_HOLD" 2>/dev/null || true
  fi
}

run() {
  local label="${1:-}"; shift || true
  [[ "${1:-}" == "--" ]] && shift || true
  [[ -n "$label" && $# -ge 1 ]] || { echo "usage: ram-seat.sh run <label> -- <cmd...>" >&2; exit 2; }
  _ensure
  _RS_TICKET="$(_alloc_ticket)"
  printf 'pid=%s\nlabel=%s\n' "$$" "$label" >"$RAM_SEAT_QUEUE/$_RS_TICKET"   # ticket pid = the waiting wrapper
  trap _cleanup EXIT INT TERM
  log "queued '$label' as $_RS_TICKET (queue depth $(ls "$RAM_SEAT_QUEUE" 2>/dev/null | wc -l | tr -d ' '))"

  local waited=0
  while :; do
    _reap_dead
    if [[ "$(_head)" == "$_RS_TICKET" ]] && mkdir "$RAM_SEAT_HOLD" 2>/dev/null; then
      printf '%s' "$$" >"$RAM_SEAT_HOLD/owner"     # the wrapper owns the seat (for cleanup)
      printf '%s' "$label" >"$RAM_SEAT_HOLD/label"
      break
    fi
    if (( waited >= RAM_SEAT_WAIT_SECONDS )); then
      log "gave up waiting for seat after ${waited}s (queue too deep / stuck holder)"
      exit 75
    fi
    sleep "$RAM_SEAT_POLL"; waited=$((waited + RAM_SEAT_POLL))
  done

  log "seat acquired by '$label' — running"
  # Run the workload as a child and record ITS pid + process-group as the seat holder, so the
  # guardian recognizes the REAL heavy proc (the python/llama that shows up in ps) and its whole
  # process group — never the wrapper. This is what keeps the seated legit job from being killed.
  "$@" &
  _RS_CHILD=$!
  printf '%s' "$_RS_CHILD" >"$RAM_SEAT_HOLD/pid"
  { ps -o pgid= -p "$_RS_CHILD" 2>/dev/null | tr -d ' '; } >"$RAM_SEAT_HOLD/pgid" || true
  local rc=0
  wait "$_RS_CHILD" || rc=$?
  log "'$label' finished (rc=$rc) — releasing seat"
  return "$rc"
}

status() {
  if [[ -f "$RAM_SEAT_HOLD/pid" ]]; then
    echo "held by $(cat "$RAM_SEAT_HOLD/label" 2>/dev/null || echo '?') (pid $(cat "$RAM_SEAT_HOLD/pid" 2>/dev/null || echo '?'))"
  else
    echo "free"
  fi
  echo "queue depth: $(ls "$RAM_SEAT_QUEUE" 2>/dev/null | wc -l | tr -d ' ')"
}

list() {
  local f
  shopt -s nullglob
  for f in $(ls "$RAM_SEAT_QUEUE" 2>/dev/null | sort); do
    printf '%s  %s\n' "$f" "$(tr '\n' ' ' <"$RAM_SEAT_QUEUE/$f" 2>/dev/null)"
  done
  shopt -u nullglob
}

# expose the current holder pid (used by the guardian to never autokill the legit job)
holder_pid() { cat "$RAM_SEAT_HOLD/pid" 2>/dev/null || true; }

main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    run)        run "$@" ;;
    status)     status ;;
    list)       list ;;
    holder-pid) holder_pid ;;
    *) echo "usage: ram-seat.sh {run <label> -- <cmd...>|status|list|holder-pid}" >&2; exit 2 ;;
  esac
}

main "$@"
