#!/usr/bin/env bun
/**
 * stamp-perf — journal-native pressure-stamp wrapper (P3a inlet). Wired as `stamp-perf`.
 *
 *   stamp-perf emit --op <op> --model <model> --batch <id> --duration <s> [--tokens <n>] [--json]
 *   stamp-perf run  --op <op> --model <model> --batch <id> [--tokens <n>] -- <command...>
 *
 * Gathers {free%, swap_used_mb, resident_models} at call time, assembles a `local.perf` payload,
 * and APPENDS it via clx (canonical journal write: server-stamped ts, path-containment, markers).
 * No daemon; invoked per batch. Honest-or-null metrics. `run` measures duration by wrapping a command.
 */
import { resolve } from "node:path";
import {
  buildPerfPayload,
  parseFreePercentage,
  parseSwapUsedMb,
  parseResidentModels,
} from "./core";

const CLX = resolve(import.meta.dir, "../clx/cli.ts");

function sh(cmd: string[]): string {
  try {
    const p = Bun.spawnSync(cmd);
    return (
      new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
    );
  } catch {
    return "";
  }
}

function gatherSystemStats() {
  return {
    freePct: parseFreePercentage(sh(["memory_pressure"])),
    swapUsedMb: parseSwapUsedMb(sh(["sysctl", "vm.swapusage"])),
    residentModels: parseResidentModels(sh(["ps", "-axo", "comm"])),
  };
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function requireFlag(args: string[], name: string): string {
  const v = getFlag(args, name);
  if (v === undefined) {
    process.stderr.write(`STAMP_PERF_USAGE: ${name} is required\n`);
    process.exit(2);
  }
  return v;
}

/** Append the payload via clx; returns the journal seq (or throws on clx failure — loud, never silent). */
function appendViaClx(payload: unknown): number {
  const p = Bun.spawnSync([
    "bun",
    CLX,
    "append",
    "perf",
    "local.perf",
    JSON.stringify(payload),
  ]);
  const out = new TextDecoder().decode(p.stdout).trim();
  if (p.exitCode !== 0) {
    process.stderr.write(
      `STAMP_PERF_CLX_FAIL: ${out}${new TextDecoder().decode(p.stderr)}\n`,
    );
    process.exit(1);
  }
  try {
    return JSON.parse(out).seq;
  } catch {
    return -1;
  }
}

function emit(args: string[], durationOverride?: number) {
  const op = requireFlag(args, "--op");
  const model = requireFlag(args, "--model");
  const chunk_batch = requireFlag(args, "--batch");
  const duration_s =
    durationOverride ?? Number(requireFlag(args, "--duration"));
  const tokensRaw = getFlag(args, "--tokens");
  const tokens = tokensRaw === undefined ? null : Number(tokensRaw);
  const stats = gatherSystemStats();
  const payload = buildPerfPayload({
    op,
    model,
    chunk_batch,
    duration_s,
    tokens,
    ...stats,
  });
  const seq = appendViaClx(payload);
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ seq, ...payload }) + "\n");
  } else {
    process.stdout.write(
      `local.perf #${seq}  ${op}/${model} batch=${chunk_batch}  ${duration_s}s  ` +
        `${payload.tokens_per_s ?? "?"} tok/s  free=${payload.memory_pressure ?? "?"}%  ` +
        `swap=${payload.swap_used_mb ?? "?"}MB  resident=[${payload.resident_models.join(",")}]\n`,
    );
  }
}

function run(args: string[]) {
  const sep = args.indexOf("--");
  if (sep < 0 || sep === args.length - 1) {
    process.stderr.write("STAMP_PERF_USAGE: run needs `-- <command...>`\n");
    process.exit(2);
  }
  const cmd = args.slice(sep + 1);
  const t0 = Bun.nanoseconds();
  const p = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  const duration_s = (Bun.nanoseconds() - t0) / 1e9;
  emit(args.slice(0, sep), duration_s);
  process.exit(p.exitCode ?? 0);
}

const argv = process.argv.slice(2);
const verb = argv[0];
if (verb === "emit") emit(argv.slice(1));
else if (verb === "run") run(argv.slice(1));
else {
  process.stderr.write("STAMP_PERF_USAGE: stamp-perf <emit|run> ...\n");
  process.exit(2);
}
