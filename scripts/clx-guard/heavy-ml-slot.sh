#!/usr/bin/env bash
# heavy-ml-slot — single-heavy-ML-slot MUTEX primitive (macOS-portable).
#
# True enforcement for COOPERATING launchers: wrap any heavy local-ML process so only
# ONE holds the slot at a time on the 36GB box (MLX / Pi / llama-server / ollama /
# whisper-server). macOS has no flock(1), so this uses an atomic mkdir lock with
# dead-holder reclamation.
#
#   heavy-ml-slot.sh with ollama serve        # acquire, run, release on exit
#   heavy-ml-slot.sh with python infer_mlx.py --model theo
#   heavy-ml-slot.sh acquire && ... && heavy-ml-slot.sh release
#   heavy-ml-slot.sh status
#
# Exit 75 (EX_TEMPFAIL) from `with` when the slot is already held — the caller knows
# another heavy-ML job is running and should back off (this is what prevents the
# concurrent-14GB-python pileup that panicked the box).
set -euo pipefail

HEAVY_ML_SLOT_LOCK="${HEAVY_ML_SLOT_LOCK:-${TMPDIR:-/tmp}/heavy-ml-slot.lock}"
HEAVY_ML_SLOT_WAIT_SECONDS="${HEAVY_ML_SLOT_WAIT_SECONDS:-0}"   # 0 = fail fast; >0 = block up to N seconds

log() { printf '[heavy-ml-slot] %s\n' "$*" >&2; }

acquire() {
  local waited=0 holder
  while ! mkdir "$HEAVY_ML_SLOT_LOCK" 2>/dev/null; do
    # Reclaim a stale lock whose holder PID is gone.
    if [[ -f "$HEAVY_ML_SLOT_LOCK/pid" ]]; then
      holder="$(cat "$HEAVY_ML_SLOT_LOCK/pid" 2>/dev/null || echo)"
      if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
        log "reclaiming stale lock from dead holder $holder"
        rm -rf "$HEAVY_ML_SLOT_LOCK"
        continue
      fi
    fi
    if (( waited >= HEAVY_ML_SLOT_WAIT_SECONDS )); then
      return 1
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done
  echo "$$" > "$HEAVY_ML_SLOT_LOCK/pid"
  return 0
}

release() { rm -rf "$HEAVY_ML_SLOT_LOCK"; }

main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    acquire)
      acquire ;;
    release)
      release ;;
    status)
      if [[ -d "$HEAVY_ML_SLOT_LOCK" ]]; then
        echo "held by $(cat "$HEAVY_ML_SLOT_LOCK/pid" 2>/dev/null || echo '?')"
      else
        echo "free"
      fi ;;
    with)
      [[ $# -ge 1 ]] || { echo "usage: heavy-ml-slot.sh with <cmd...>" >&2; exit 2; }
      if ! acquire; then
        log "slot busy ($(cat "$HEAVY_ML_SLOT_LOCK/pid" 2>/dev/null || echo '?')) — refusing concurrent heavy-ML"
        exit 75
      fi
      trap release EXIT
      "$@" ;;
    *)
      echo "usage: heavy-ml-slot.sh {acquire|release|status|with <cmd...>}" >&2
      exit 2 ;;
  esac
}

main "$@"
