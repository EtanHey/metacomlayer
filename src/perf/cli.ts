#!/usr/bin/env bun
/**
 * stamp-perf — journal-native pressure-stamp wrapper (P3a inlet). Wired as `stamp-perf`.
 *
 *   stamp-perf emit --op <op> --model <model> --batch <id> --duration <s> [--tokens <n>] [--json]
 *   stamp-perf run  --op <op> --model <model> --batch <id> [--tokens <n>] -- <command...>
 *   stamp-perf cli-run --agent <name> --repo <repo> --duration <s> --outcome <ok|fail|killed> [--pr <n>] [--json]
 *   stamp-perf snapshot [--json]
 *
 * Gathers {free%, swap_used_mb, resident_models} at call time, assembles a `local.perf` payload,
 * and APPENDS it via clx (canonical journal write: server-stamped ts, path-containment, markers).
 * No daemon; invoked per batch. Honest-or-null metrics. `run` measures duration by wrapping a command.
 */
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  buildCliRunPayload,
  buildPerfPayload,
  buildSysSnapshotPayload,
  type CliRunOutcome,
  parseFreePercentage,
  parseOpenApps,
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

function gatherOpenApps() {
  return parseOpenApps(
    sh([
      "osascript",
      "-e",
      'tell application "System Events" to get name of (every process whose background only is false)',
    ]),
  );
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

function requireNumberFlag(args: string[], name: string): number {
  const raw = requireFlag(args, name);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    process.stderr.write(`STAMP_PERF_USAGE: ${name} must be a number\n`);
    process.exit(2);
  }
  return n;
}

function requireOutcome(args: string[]): CliRunOutcome {
  const outcome = requireFlag(args, "--outcome");
  if (outcome !== "ok" && outcome !== "fail" && outcome !== "killed") {
    process.stderr.write(
      "STAMP_PERF_USAGE: --outcome must be ok, fail, or killed\n",
    );
    process.exit(2);
  }
  return outcome;
}

/** Append the payload via clx; returns the journal seq (or throws on clx failure — loud, never silent). */
function appendViaClx(topic: string, type: string, payload: unknown): number {
  const home = process.env.HOME;
  if (home) mkdirSync(resolve(home, ".local/share/orc"), { recursive: true });
  const p = Bun.spawnSync([
    "bun",
    CLX,
    "append",
    topic,
    type,
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
  const seq = appendViaClx("perf", "local.perf", payload);
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

function cliRun(args: string[]) {
  const prRaw = getFlag(args, "--pr");
  const payload = buildCliRunPayload({
    agent: requireFlag(args, "--agent"),
    repo: requireFlag(args, "--repo"),
    durationS: requireNumberFlag(args, "--duration"),
    outcome: requireOutcome(args),
    ...(prRaw === undefined ? {} : { pr: Number(prRaw) }),
  });
  if (prRaw !== undefined && !Number.isFinite(payload.pr)) {
    process.stderr.write("STAMP_PERF_USAGE: --pr must be a number\n");
    process.exit(2);
  }
  const seq = appendViaClx("cli", "cli.run", payload);
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ seq, ...payload }) + "\n");
  } else {
    process.stdout.write(
      `cli.run #${seq}  ${payload.agent}/${payload.repo}  ${payload.duration_s}s  ${payload.outcome}` +
        (payload.pr === undefined ? "" : `  PR #${payload.pr}`) +
        "\n",
    );
  }
}

function snapshot(args: string[]) {
  const stats = gatherSystemStats();
  const payload = buildSysSnapshotPayload({
    ...stats,
    openApps: gatherOpenApps(),
  });
  const seq = appendViaClx("sys", "sys.snapshot", payload);
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ seq, ...payload }) + "\n");
  } else {
    process.stdout.write(
      `sys.snapshot #${seq}  free=${payload.memory_pressure ?? "?"}%  ` +
        `swap=${payload.swap_used_mb ?? "?"}MB  resident=[${payload.resident_models.join(",")}]  ` +
        `apps=[${payload.open_apps.join(",")}]\n`,
    );
  }
}

const argv = process.argv.slice(2);
const verb = argv[0];
if (verb === "emit") emit(argv.slice(1));
else if (verb === "run") run(argv.slice(1));
else if (verb === "cli-run") cliRun(argv.slice(1));
else if (verb === "snapshot") snapshot(argv.slice(1));
else {
  process.stderr.write(
    "STAMP_PERF_USAGE: stamp-perf <emit|run|cli-run|snapshot> ...\n",
  );
  process.exit(2);
}
