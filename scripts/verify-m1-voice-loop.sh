#!/usr/bin/env bash
# M1 — park-and-resume voice loop (gen-16 GLOBAL MILESTONE) proof harness.
#
# Proves, end to end and from the journal only:
#   1. P1a re-run    — clx park → emit late → resume folds the late arrival (no recency drop)
#   2. socket round  — a real JSON-RPC request/response over the LIVE voicelayer MCP daemon
#                      (/tmp/voicelayer-mcp.sock), incl. a silent voice_speak tool CALL (think mode,
#                      no midnight audio) — the "scripted socket-level round-trip" (M3 redef)
#   3. Theo read-back— render the resumed brief to a theo-n4a wav via the proven render script
#                      (absolute paths; voicelayer-confirmed signature) — "Theo TTS invoked directly"
#   4. milestone row — record M1 to the CANONICAL fleet journal via clx itself (dogfood)
#
# Design notes (why this shape):
#   - Lead-authored proof harness (Codex held <10% weekly); same class as the clx spine
#     proof + adversarial battery the lead already ran. No daemon code change.
#   - voicelayer corrections honored: /tmp/voicelayer.sock is VoiceBar-as-SENDER (wrong dir for a
#     scripted client) → we use the MCP socket /tmp/voicelayer-mcp.sock. We never start a 2nd daemon.
#   - Deterministic + repeatable: clx runs against an ISOLATED proof DB under the path-containment
#     base (~/.local/share/orc/), reset each run. The CANONICAL journal is touched once, for the
#     milestone row only.
#   - No surprise audio: socket round-trip uses voice_speak `think` (silent log); read-back renders
#     to a wav FILE (not played aloud).
set -euo pipefail

# --- config / paths ------------------------------------------------------------
ORC_DIR="$HOME/.local/share/orc"
PROOF_DB="$ORC_DIR/m1-proof.sqlite3"
CANON_DB="$ORC_DIR/fleet-journal.db"
MCP_SOCK="/tmp/voicelayer-mcp.sock"
VL="$HOME/Gits/voicelayer/docs.local/voice-clone-2026-06-06"
PY="$VL/tts-env/bin/python"
VOICE_JSON="$VL/logs/night/voice-n4a.json"
TTS_MODEL="mlx-community/Qwen3-TTS-12Hz-1.7B-Base-4bit"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLX=("bun" "$REPO_ROOT/src/clx/cli.ts")
WORK="$(mktemp -d)"
OUT_WAV="$ORC_DIR/m1-readback.wav"
SEAT="m1"
BRIEF="resume at step 3: canary list half-built; pi-vs-hermes still undecided"

pass(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail(){ printf '  \033[31m✗ FAIL:\033[0m %s\n' "$1" >&2; exit 1; }
step(){ printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

mkdir -p "$ORC_DIR"

# ===============================================================================
step "1/4  P1a re-run — park → late emit → resume (journal-only, late arrival folded)"
export JOURNAL_DB="$PROOF_DB"
rm -f "$PROOF_DB" "$PROOF_DB-wal" "$PROOF_DB-shm"

"${CLX[@]}" park "$SEAT" --brief "$BRIEF" >/dev/null
"${CLX[@]}" emit "$SEAT.late" '{"late":"arrived after park"}' >/dev/null
RESUME="$("${CLX[@]}" resume "$SEAT")"

echo "$RESUME" | grep -qF "$BRIEF"              || fail "resume missing the parked brief"
echo "$RESUME" | grep -qE "LATE ARRIVALS\(1\)"  || fail "late arrival not folded into resume"
echo "$RESUME" | grep -qE "journal_seq_watermark: [0-9]+" || fail "no seq watermark in resume"
echo "$RESUME" | grep -qF '"late":"arrived after park"'   || fail "late payload absent"
pass "resume rebuilt from journal only; LATE ARRIVALS(1) folded; watermark present"

# the human-meaningful brief line(s): everything between 'BRIEF' and the watermark line
READBACK_TEXT="$(printf '%s\n' "$RESUME" | awk '/^BRIEF$/{f=1;next} /^journal_seq_watermark:/{f=0} f')"
[ -n "$READBACK_TEXT" ] || fail "could not extract read-back text from resume"
pass "read-back text extracted: \"$READBACK_TEXT\""

# ===============================================================================
step "2/4  scripted socket round-trip — live voicelayer MCP daemon ($MCP_SOCK)"
[ -S "$MCP_SOCK" ] || fail "MCP socket not present — is VoiceBar/daemon up?"
command -v socat >/dev/null || fail "socat not installed"

REQS="$WORK/mcp-reqs.ndjson"
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"clx-m1","version":"0.1"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"voice_speak","arguments":{"message":"note: clx M1 park-and-resume socket round-trip probe","mode":"think"}}}'
} > "$REQS"

MCP_OUT="$(timeout 12 socat -t4 STDIO "UNIX-CONNECT:$MCP_SOCK" < "$REQS" 2>/dev/null || true)"
echo "$MCP_OUT" | grep -qF '"serverInfo"' && echo "$MCP_OUT" | grep -qF '"voicelayer"' \
  || fail "initialize did not return voicelayer serverInfo (round-trip dead)"
pass "initialize round-trip → serverInfo voicelayer"
echo "$MCP_OUT" | grep -qF '"voice_speak"' || fail "voice_speak not advertised in tools/list"
pass "tools/list round-trip → voice_speak advertised"
# id:3 must return a result (not an error) for the silent tool call
echo "$MCP_OUT" | grep -qE '"id":3,"result"' || fail "voice_speak(think) tool call did not return a result"
pass "voice_speak(think) silent tool CALL round-tripped (no audio emitted)"

# ===============================================================================
step "3/4  Theo read-back — render resumed brief to theo-n4a wav (direct mlx_audio engine)"
# NOTE: voicelayer's production wrapper render-night-briefing.py has a chunk-0 failure
# (sf.write crashes on an empty 'full' array when a chunk fails — latent all-chunks-failed bug)
# reproducible at 83% free mem — handed to @voicelayerLead. The mlx_audio ENGINE itself is fine,
# so M1's read-back invokes Theo DIRECTLY (theo-n4a ref clip) — which IS "Theo TTS invoked directly".
[ -x "$PY" ] || fail "tts python missing: $PY"
[ -f "$VOICE_JSON" ] || fail "theo-n4a profile missing: $VOICE_JSON"
RA="$("$PY" -c "import json,sys;print(json.load(open('$VOICE_JSON'))['ref_audio'])")"
RT="$("$PY" -c "import json,sys;print(json.load(open('$VOICE_JSON'))['ref_text'])")"
TEMP="$("$PY" -c "import json;print(json.load(open('$VOICE_JSON'))['temperature'])")"
TOPP="$("$PY" -c "import json;print(json.load(open('$VOICE_JSON'))['top_p'])")"
TOPK="$("$PY" -c "import json;print(json.load(open('$VOICE_JSON'))['top_k'])")"
[ -f "$RA" ] || fail "theo-n4a ref_audio missing: $RA"
RB_DIR="$ORC_DIR/m1-readback"; rm -rf "$RB_DIR"; mkdir -p "$RB_DIR"
# render to FILE (not played aloud — no surprise midnight audio); nice'd
nice -n 10 "$PY" -m mlx_audio.tts.generate --model "$TTS_MODEL" \
  --text "$READBACK_TEXT" --ref_audio "$RA" --ref_text "$RT" \
  --output_path "$RB_DIR" --file_prefix m1-readback --audio_format wav --join_audio \
  --temperature "$TEMP" --top_p "$TOPP" --top_k "$TOPK" >"$RB_DIR/render.log" 2>&1 \
  || { tail -20 "$RB_DIR/render.log" >&2; fail "mlx_audio.tts.generate exited non-zero"; }
OUT_WAV="$(ls -t "$RB_DIR"/m1-readback*.wav 2>/dev/null | head -1)"
[ -n "$OUT_WAV" ] && [ -s "$OUT_WAV" ] || fail "read-back wav not produced in $RB_DIR"
DUR="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT_WAV" 2>/dev/null || echo 0)"
awk "BEGIN{exit !($DUR > 0)}" || fail "read-back wav has zero duration"
pass "theo-n4a wav rendered from the resume text: $OUT_WAV (${DUR}s)"

# ===============================================================================
step "4/4  record M1 milestone to the CANONICAL journal (dogfood)"
unset JOURNAL_DB   # back to the canonical fleet-journal.db
M1_PAYLOAD="$(printf '{"milestone":"M1","loop":"park-resume-voice","wav":"%s","wav_seconds":%s,"socket":"%s","by":"controllayerClaude","codex_used":false}' "$OUT_WAV" "$DUR" "$MCP_SOCK")"
"${CLX[@]}" append milestone m1.done "$M1_PAYLOAD" >/dev/null
"${CLX[@]}" tail --topic milestone | grep -qF '"milestone":"M1"' || fail "M1 row not in canonical journal"
pass "M1 recorded in canonical journal (clx tail confirms)"

printf '\n\033[1;32m🟢 M1 GREEN — park-and-resume voice loop proven end-to-end.\033[0m\n'
printf '   journal→resume→late-fold ✓   live MCP socket round-trip ✓   theo-n4a read-back wav ✓ (%ss)\n' "$DUR"
printf '   qa clip: %s\n' "$OUT_WAV"
