/**
 * perf stamp — pure parsers + payload assembly for the journal-native pressure-stamp wrapper.
 *
 * Emits `local.perf` events (via clx) around any local-model batch — the R5 contention-experiment
 * data inlet + the prediction-layer feed ("what causes what on the Mac"). No daemon: a wrapper the
 * Pass-3 run (and future local jobs) invokes per batch. All metrics are honest-or-null (never faked).
 */

/** `memory_pressure` → "System-wide memory free percentage: 88%" → 88 (or null). */
export function parseFreePercentage(out: string): number | null {
  const m = out.match(/free percentage:\s*(\d+)%/i);
  return m ? Number(m[1]) : null;
}

/** `sysctl vm.swapusage` → "... used = 6119.06M ..." → 6119.06 (MB) or null. */
export function parseSwapUsedMb(out: string): number | null {
  const m = out.match(/used\s*=\s*([\d.]+)M/i);
  return m ? Number(m[1]) : null;
}

const MODEL_PROC = /mlx|ollama|llama|qwen|gguf/i;

/** `ps -axo comm` → distinct model-server process names (mlx/ollama/...), [] when none. */
export function parseResidentModels(
  psOut: string,
  pattern: RegExp = MODEL_PROC,
): string[] {
  const seen = new Set<string>();
  for (const line of psOut.split("\n")) {
    const name = line.trim();
    if (name.length === 0) continue;
    if (pattern.test(name)) seen.add(name);
  }
  return [...seen];
}

/** `osascript` visible-process list → app names, or [] when output is empty/error-shaped. */
export function parseOpenApps(osascriptOutput: string): string[] {
  const out = osascriptOutput.trim();
  if (out.length === 0) return [];
  if (/error|execution error|not authorized|not allowed/i.test(out)) return [];
  if (!out.includes(",")) return [];
  return out
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** tokens/sec, only when both are present and duration > 0 (else null — no divide-by-zero, no fabrication). */
export function computeTokensPerS(
  tokens: number | null,
  durationS: number,
): number | null {
  if (tokens === null || tokens === undefined) return null;
  if (!(durationS > 0)) return null;
  return tokens / durationS;
}

export interface PerfPayload {
  op: string;
  model: string;
  chunk_batch: string;
  duration_s: number;
  tokens_per_s: number | null;
  memory_pressure: number | null; // free %
  swap_used_mb: number | null;
  resident_models: string[];
}

export function buildPerfPayload(input: {
  op: string;
  model: string;
  chunk_batch: string;
  duration_s: number;
  tokens: number | null;
  freePct: number | null;
  swapUsedMb: number | null;
  residentModels: string[];
}): PerfPayload {
  return {
    op: input.op,
    model: input.model,
    chunk_batch: input.chunk_batch,
    duration_s: input.duration_s,
    tokens_per_s: computeTokensPerS(input.tokens, input.duration_s),
    memory_pressure: input.freePct,
    swap_used_mb: input.swapUsedMb,
    resident_models: input.residentModels,
  };
}

export type CliRunOutcome = "ok" | "fail" | "killed";

export interface CliRunPayload {
  agent: string;
  repo: string;
  duration_s: number;
  outcome: CliRunOutcome;
  pr?: number;
}

export function buildCliRunPayload(input: {
  agent: string;
  repo: string;
  durationS: number;
  outcome: CliRunOutcome;
  pr?: number;
}): CliRunPayload {
  return {
    agent: input.agent,
    repo: input.repo,
    duration_s: input.durationS,
    outcome: input.outcome,
    ...(input.pr === undefined ? {} : { pr: input.pr }),
  };
}

export interface SysSnapshotPayload {
  memory_pressure: number | null;
  swap_used_mb: number | null;
  resident_models: string[];
  open_apps: string[];
}

export function buildSysSnapshotPayload(input: {
  freePct: number | null;
  swapUsedMb: number | null;
  residentModels: string[];
  openApps: string[];
}): SysSnapshotPayload {
  return {
    memory_pressure: input.freePct,
    swap_used_mb: input.swapUsedMb,
    resident_models: input.residentModels,
    open_apps: input.openApps,
  };
}
