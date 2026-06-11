#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/pass3-runner.sh [--dry-run] [options]

Windowed Pass-3 local graphify runner. Each Ollama batch is wrapped by
`bun run stamp-perf run`, writes one local.perf journal row, and records a
resumable checkpoint under ~/.local/share/orc by default.

Options:
  --dry-run                 Run exactly one tiny real batch, then stop.
  --model MODEL             Preferred Ollama model (default: qwen2.5-coder:14b).
  --repo NAME=PATH          Add/override a repo target. Can be repeated.
  --repos NAME=PATH,...     Replace default repo targets with this ordered list.
  --batch-size BYTES        Max content bytes per full-run batch (default: 24000).
  --dry-run-bytes BYTES     Max content bytes for the one dry-run batch (default: 1800).
  --checkpoint PATH         Checkpoint JSON path (default: ~/.local/share/orc/pass3-checkpoint.json).
  --memory-threshold PCT    Abort when memory free percentage is below PCT (default: 15).
  --help                    Show this help.

Environment:
  PASS3_MEMORY_THRESHOLD    Same as --memory-threshold. Useful for abort-path tests.
  PASS3_CHECKPOINT          Same as --checkpoint.
  PASS3_BATCH_SIZE          Same as --batch-size.
  PASS3_DRY_RUN_BYTES       Same as --dry-run-bytes.
  PASS3_REPOS               Same format as --repos.
EOF
}

die() {
  printf 'PASS3_RUNNER_ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

json_escape() {
  JSON_VALUE="$1" bun --silent --eval 'process.stdout.write(JSON.stringify(process.env.JSON_VALUE ?? ""))'
}

orc_base() {
  printf '%s/.local/share/orc' "${HOME:?HOME is required}"
}

DEFAULT_MODEL="qwen2.5-coder:14b"
MODEL="$DEFAULT_MODEL"
ACTUAL_MODEL="$DEFAULT_MODEL"
DRY_RUN=0
BATCH_SIZE="${PASS3_BATCH_SIZE:-24000}"
DRY_RUN_BYTES="${PASS3_DRY_RUN_BYTES:-1800}"
CHECKPOINT="${PASS3_CHECKPOINT:-$(orc_base)/pass3-checkpoint.json}"
MEMORY_THRESHOLD="${PASS3_MEMORY_THRESHOLD:-15}"
REPOS_SPEC="${PASS3_REPOS:-}"
declare -a REPO_SPECS=()
PASS3_TMP_ROOT=""

default_repos() {
  local root="${PASS3_REPO_ROOT:-$HOME/Gits}"
  printf 'cmuxlayer=%s/cmuxlayer\n' "$root"
  printf 'golems=%s/golems\n' "$root"
  printf 'orchestrator=%s/orchestrator\n' "$root"
  printf 'brainlayer=%s/brainlayer\n' "$root"
  printf 'voicelayer=%s/voicelayer\n' "$root"
  printf 'metacomlayer=%s/metacomlayer\n' "$root"
}

set_repos_from_csv() {
  local spec="$1"
  REPO_SPECS=()
  local item
  local old_ifs="$IFS"
  IFS=','
  for item in $spec; do
    [[ -n "$item" ]] && REPO_SPECS+=("$item")
  done
  IFS="$old_ifs"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --model)
      MODEL="${2:-}"
      [[ -n "$MODEL" ]] || die "--model requires a value"
      shift 2
      ;;
    --repo)
      repo_arg="${2:-}"
      [[ -n "$repo_arg" ]] || die "--repo requires NAME=PATH"
      REPO_SPECS+=("$repo_arg")
      shift 2
      ;;
    --repos)
      set_repos_from_csv "${2:-}"
      [[ ${#REPO_SPECS[@]} -gt 0 ]] || die "--repos requires NAME=PATH entries"
      shift 2
      ;;
    --batch-size)
      BATCH_SIZE="${2:-}"
      shift 2
      ;;
    --dry-run-bytes)
      DRY_RUN_BYTES="${2:-}"
      shift 2
      ;;
    --checkpoint)
      CHECKPOINT="${2:-}"
      [[ -n "$CHECKPOINT" ]] || die "--checkpoint requires a path"
      shift 2
      ;;
    --memory-threshold)
      MEMORY_THRESHOLD="${2:-}"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || die "--batch-size must be an integer"
[[ "$DRY_RUN_BYTES" =~ ^[0-9]+$ ]] || die "--dry-run-bytes must be an integer"
[[ "$MEMORY_THRESHOLD" =~ ^[0-9]+$ ]] || die "--memory-threshold must be an integer"

if [[ ${#REPO_SPECS[@]} -eq 0 && -n "$REPOS_SPEC" ]]; then
  set_repos_from_csv "$REPOS_SPEC"
fi
if [[ ${#REPO_SPECS[@]} -eq 0 ]]; then
  while IFS= read -r line; do
    REPO_SPECS+=("$line")
  done < <(default_repos)
fi

require_cmd bun
require_cmd memory_pressure
require_cmd ollama
mkdir -p "$(dirname "$CHECKPOINT")"

checkpoint_has() {
  CHECKPOINT_PATH="$CHECKPOINT" CHECKPOINT_REPO="$1" CHECKPOINT_BATCH="$2" bun --silent --eval '
const fs = require("node:fs");
const path = process.env.CHECKPOINT_PATH;
const repo = process.env.CHECKPOINT_REPO;
const batch = Number(process.env.CHECKPOINT_BATCH);
let data = { completed: [] };
try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
const done = Array.isArray(data.completed) && data.completed.some((row) => row && row.repo === repo && row.batch === batch);
process.exit(done ? 0 : 1);
'
}

checkpoint_add() {
  CHECKPOINT_PATH="$CHECKPOINT" CHECKPOINT_REPO="$1" CHECKPOINT_BATCH="$2" CHECKPOINT_MODEL="$3" bun --silent --eval '
const fs = require("node:fs");
const path = process.env.CHECKPOINT_PATH;
const repo = process.env.CHECKPOINT_REPO;
const batch = Number(process.env.CHECKPOINT_BATCH);
const model = process.env.CHECKPOINT_MODEL;
let data = { completed: [] };
try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
if (!Array.isArray(data.completed)) data.completed = [];
if (!data.completed.some((row) => row && row.repo === repo && row.batch === batch)) {
  data.completed.push({ repo, batch, model, completed_at: new Date().toISOString() });
}
fs.mkdirSync(require("node:path").dirname(path), { recursive: true });
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
'
}

free_memory_pct() {
  memory_pressure 2>/dev/null | sed -nE 's/.*[Ff]ree percentage:[[:space:]]*([0-9]+)%.*/\1/p' | head -n 1
}

append_abort_event() {
  local repo="$1"
  local batch="$2"
  local free_pct="$3"
  local threshold="$4"
  local payload
  payload="$(printf '{"op":"pass3-graphify","repo":%s,"batch":%s,"model":%s,"requested_model":%s,"memory_pressure":%s,"threshold":%s,"reason":"memory pressure below threshold"}' \
    "$(json_escape "$repo")" \
    "$(json_escape "$batch")" \
    "$(json_escape "$ACTUAL_MODEL")" \
    "$(json_escape "$MODEL")" \
    "$(json_escape "$free_pct")" \
    "$(json_escape "$threshold")")"
  bun run clx append perf pass3.aborted "$payload" >/dev/null
}

assert_memory_ok() {
  local repo="$1"
  local batch="$2"
  local free_pct
  free_pct="$(free_memory_pct || true)"
  if [[ -z "$free_pct" ]]; then
    printf 'PASS3_MEMORY_CHECK: free percentage unavailable; continuing with stamp-perf honest-null metrics\n' >&2
    return 0
  fi
  if (( free_pct < MEMORY_THRESHOLD )); then
    append_abort_event "$repo" "$batch" "$free_pct" "$MEMORY_THRESHOLD"
    printf 'PASS3_ABORTED: memory free %s%% is below threshold %s%% before %s:%s; journaled pass3.aborted\n' \
      "$free_pct" "$MEMORY_THRESHOLD" "$repo" "$batch" >&2
    exit 75
  fi
}

model_available() {
  local model="$1"
  ollama list 2>/dev/null | awk 'NR > 1 { print $1 }' | grep -Fx -- "$model" >/dev/null
}

first_available_model() {
  ollama list 2>/dev/null | awk 'NR > 1 && $1 != "" { print $1; exit }'
}

select_model() {
  if model_available "$MODEL"; then
    printf '%s\n' "$MODEL"
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    local fallback
    fallback="$(first_available_model || true)"
    [[ -n "$fallback" ]] || die "preferred model $MODEL is unavailable and no Ollama fallback model is installed for dry-run"
    printf 'PASS3_MODEL_FALLBACK: preferred %s unavailable; dry-run will stamp actual model %s\n' "$MODEL" "$fallback" >&2
    printf '%s\n' "$fallback"
    return 0
  fi
  printf 'PASS3_MODEL_PULL: pulling missing model %s before full run\n' "$MODEL" >&2
  ollama pull "$MODEL"
  printf '%s\n' "$MODEL"
}

make_batches() {
  local repo_name="$1"
  local repo_path="$2"
  local bytes="$3"
  local out_dir="$4"
  # shellcheck disable=SC2016
  REPO_NAME="$repo_name" REPO_PATH="$repo_path" BATCH_BYTES="$bytes" OUT_DIR="$out_dir" bun --silent --eval '
const fs = require("node:fs");
const path = require("node:path");
const repoName = process.env.REPO_NAME;
const repoPath = process.env.REPO_PATH;
const maxBytes = Number(process.env.BATCH_BYTES);
const outDir = process.env.OUT_DIR;
const skipDirs = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo", ".cache"]);
const skipExt = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|mp4|mov|mp3|wav|sqlite|db|lock)$/i;
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(full, acc);
    } else if (entry.isFile() && !skipExt.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}
fs.mkdirSync(outDir, { recursive: true });
let batch = "";
let batchNo = 0;
function flush() {
  if (batch.length === 0) return;
  batchNo += 1;
  fs.writeFileSync(path.join(outDir, `${batchNo}.txt`), [
    `Pass-3 graphify batch for ${repoName} #${batchNo}.`,
    "Extract graph entities, relationships, unresolved risks, and implementation facts. Return compact JSONL.",
    "",
    batch,
  ].join("\n"));
  batch = "";
}
for (const file of walk(repoPath)) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
  if (raw.includes("\u0000")) continue;
  const rel = path.relative(repoPath, file);
  let chunk = `\n--- FILE ${rel} ---\n${raw}\n`;
  if (Buffer.byteLength(chunk, "utf8") > maxBytes) {
    chunk = chunk.slice(0, maxBytes) + "\n[TRUNCATED]\n";
  }
  if (Buffer.byteLength(batch + chunk, "utf8") > maxBytes && batch.length > 0) flush();
  batch += chunk;
  if (Buffer.byteLength(batch, "utf8") >= maxBytes) flush();
}
flush();
process.stdout.write(String(batchNo));
'
}

run_batch() {
  local repo_name="$1"
  local batch_no="$2"
  local prompt_file="$3"
  local actual_model="$4"
  local batch_id="${repo_name}:${batch_no}"

  assert_memory_ok "$repo_name" "$batch_no"
  if checkpoint_has "$repo_name" "$batch_no"; then
    printf 'PASS3_SKIP: checkpoint already contains %s\n' "$batch_id"
    return 2
  fi

  printf 'PASS3_RUN: %s model=%s prompt=%s\n' "$batch_id" "$actual_model" "$prompt_file"
  # shellcheck disable=SC2016
  OLLAMA_KEEP_ALIVE=0 bun run stamp-perf run \
    --op pass3-graphify \
    --model "$actual_model" \
    --batch "$batch_id" \
    -- bash -c 'OLLAMA_KEEP_ALIVE=0 ollama run "$1" < "$2"' _ "$actual_model" "$prompt_file"
  checkpoint_add "$repo_name" "$batch_no" "$actual_model"
}

main() {
  local actual_model
  actual_model="$(select_model)"
  ACTUAL_MODEL="$actual_model"
  local tmp_root
  tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/pass3-runner.XXXXXX")"
  PASS3_TMP_ROOT="$tmp_root"
  trap 'rm -rf "$PASS3_TMP_ROOT"' EXIT

  local completed_this_invocation=0
  local repo_spec repo_name repo_path max_bytes batch_count batch_no prompt_file result
  for repo_spec in "${REPO_SPECS[@]}"; do
    [[ "$repo_spec" == *=* ]] || die "repo spec must be NAME=PATH: $repo_spec"
    repo_name="${repo_spec%%=*}"
    repo_path="${repo_spec#*=}"
    if [[ ! -d "$repo_path" ]]; then
      printf 'PASS3_REPO_SKIP: %s missing at %s\n' "$repo_name" "$repo_path" >&2
      continue
    fi
    max_bytes="$BATCH_SIZE"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      max_bytes="$DRY_RUN_BYTES"
    fi
    batch_count="$(make_batches "$repo_name" "$repo_path" "$max_bytes" "$tmp_root/$repo_name")"
    [[ "$batch_count" =~ ^[0-9]+$ ]] || die "batch generation failed for $repo_name"
    if (( batch_count == 0 )); then
      printf 'PASS3_REPO_SKIP: %s produced no text batches\n' "$repo_name" >&2
      continue
    fi
    for (( batch_no = 1; batch_no <= batch_count; batch_no++ )); do
      prompt_file="$tmp_root/$repo_name/$batch_no.txt"
      set +e
      run_batch "$repo_name" "$batch_no" "$prompt_file" "$actual_model"
      result=$?
      set -e
      if [[ "$result" -eq 0 ]]; then
        completed_this_invocation=$((completed_this_invocation + 1))
        if [[ "$DRY_RUN" -eq 1 ]]; then
          printf 'PASS3_DRY_RUN_DONE: completed exactly one batch; full run not fired\n'
          return 0
        fi
      elif [[ "$result" -eq 2 ]]; then
        if [[ "$DRY_RUN" -eq 1 ]]; then
          printf 'PASS3_DRY_RUN_DONE: first tiny batch already checkpointed; resume skip proven; full run not fired\n'
          return 0
        fi
      else
        return "$result"
      fi
    done
  done

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'PASS3_DRY_RUN_DONE: no runnable uncheckpointed batch found; full run not fired\n'
  else
    printf 'PASS3_FULL_RUN_DONE: completed %s new batches\n' "$completed_this_invocation"
  fi
}

main
