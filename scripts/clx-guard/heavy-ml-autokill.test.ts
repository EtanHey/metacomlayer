import { test, expect, beforeAll } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = join(import.meta.dir);
const GUARDIAN = join(DIR, "heavy-ml-guardian.sh");

let work: string;
let FAKE_KILL: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "autokill-"));
  // fake kill: record "signal pid"; for `-0` report the proc as already gone (no escalation)
  FAKE_KILL = join(work, "fake-kill.sh");
  writeFileSync(
    FAKE_KILL,
    `#!/usr/bin/env bash\nif [[ "$1" == "-0" ]]; then exit 1; fi\necho "$1 $2" >> "$FAKE_KILL_LOG"\nexit 0\n`,
  );
  chmodSync(FAKE_KILL, 0o755);
});

const KB = (gb: number) => Math.round(gb * 1024 * 1024);
let n = 0;
function psFixture(lines: string[]): string {
  const p = join(work, `ps-${n++}.txt`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
function vmstat(pages: number): string {
  const p = join(work, `vm-${pages}-${n++}.txt`);
  writeFileSync(
    p,
    `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor:        ${pages}.\n`,
  );
  return p;
}
const DANGER = () => vmstat(1_000_000); // ~15.3GB > 12GB compressor danger
const SAFE = () => vmstat(50_000); // ~0.8GB

// a fresh sample so sampler_stale doesn't fire (unless we want it to)
const SAMPLE_TS = "2026-06-14T09:00:00+0300";
function freshSample() {
  const p = join(work, `samples-${n++}.jsonl`);
  writeFileSync(p, `{"ts":"${SAMPLE_TS}"}\n`);
  const ep = parseInt(
    execFileSync("date", ["-j", "-f", "%Y-%m-%dT%H:%M:%S%z", SAMPLE_TS, "+%s"])
      .toString()
      .trim(),
    10,
  );
  return { file: p, now: String(ep + 60) };
}

function runGuardian(ps: string, vm: string, extra: Record<string, string>) {
  const log = join(work, `kill-${n++}.log`);
  const seat = join(work, `seat-${n}`); // a holder dir path (may be created by test)
  const fresh = freshSample();
  const env: Record<string, string> = {
    ...process.env,
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: vm,
    HEAVY_ML_SAMPLE_FILE: fresh.file,
    HEAVY_ML_NOW_EPOCH: fresh.now,
    HEAVY_ML_NOTIFY_URL: "http://127.0.0.1:9/notify",
    HEAVY_ML_CLX_CLI: "",
    HEAVY_ML_GUARD_ENABLE_KILL: "1",
    HEAVY_ML_KILL_BIN: FAKE_KILL,
    HEAVY_ML_TERM_GRACE_SECONDS: "0",
    FAKE_KILL_LOG: log,
    RAM_SEAT_HOLD: seat,
    ...extra,
  };
  const r = spawnSync("bash", [GUARDIAN], { env, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const killed = existsSync(log) ? readFileSync(log, "utf8").trim() : "";
  return { out, killed, seat };
}

test("autokill TERMs a true runaway (non-protected, >=12G) under real danger", () => {
  const ps = psFixture([
    `7001 ${KB(14)} /opt/homebrew/.../python3.11 runaway_train.py`,
  ]);
  const { killed } = runGuardian(ps, DANGER(), {});
  expect(killed).toContain("-TERM 7001");
});

test("PROTECTED daemons are NEVER killed, even at 14G under danger", () => {
  const ps = psFixture([
    `7002 ${KB(14)} /opt/homebrew/bin/whisper-server -m ggml-large-v3-turbo.bin`,
  ]);
  const { killed, out } = runGuardian(ps, DANGER(), {});
  expect(killed).toBe(""); // nothing killed
  expect(out).toContain("NO true runaway");
});

test("the RAM-seat holder (legit heavy job) is NEVER killed", () => {
  const ps = psFixture([
    `7003 ${KB(20)} /opt/homebrew/.../python3.11 reembed_backfill.py`,
  ]);
  const { seat } = runGuardian(ps, SAFE(), {}); // first call just to get a seat path
  // mark pid 7003 as the legit seat holder, then run under danger
  mkdirSync(seat, { recursive: true });
  writeFileSync(join(seat, "pid"), "7003");
  const log = join(work, `kill-seat.log`);
  const fresh = freshSample();
  const env = {
    ...process.env,
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: DANGER(),
    HEAVY_ML_SAMPLE_FILE: fresh.file,
    HEAVY_ML_NOW_EPOCH: fresh.now,
    HEAVY_ML_NOTIFY_URL: "http://127.0.0.1:9/notify",
    HEAVY_ML_CLX_CLI: "",
    HEAVY_ML_GUARD_ENABLE_KILL: "1",
    HEAVY_ML_KILL_BIN: FAKE_KILL,
    HEAVY_ML_TERM_GRACE_SECONDS: "0",
    FAKE_KILL_LOG: log,
    RAM_SEAT_HOLD: seat,
  };
  const r = spawnSync("bash", [GUARDIAN], { env, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  expect(existsSync(log) ? readFileSync(log, "utf8").trim() : "").toBe("");
  expect(out).toContain("NO true runaway");
});

test("NO kill when system is NOT in danger (only sampler_stale), even with a 14G proc", () => {
  const ps = psFixture([`7004 ${KB(14)} /opt/homebrew/.../python3.11 big.py`]);
  const log = join(work, `kill-nodanger.log`);
  const env = {
    ...process.env,
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: SAFE(), // compressor low -> not danger
    HEAVY_ML_SAMPLE_FILE: join(work, "nope.jsonl"), // missing -> sampler_stale
    HEAVY_ML_NOW_EPOCH: "9999999999",
    HEAVY_ML_NOTIFY_URL: "http://127.0.0.1:9/notify",
    HEAVY_ML_CLX_CLI: "",
    HEAVY_ML_GUARD_ENABLE_KILL: "1",
    HEAVY_ML_KILL_BIN: FAKE_KILL,
    HEAVY_ML_TERM_GRACE_SECONDS: "0",
    FAKE_KILL_LOG: log,
    RAM_SEAT_HOLD: join(work, "noseat"),
    HEAVY_ML_AGG_DANGER_GB: "24", // 14 < 24 so no aggregate danger either
  };
  const out = execFileSync("bash", [GUARDIAN], { env }).toString();
  expect(out).toContain("sampler_stale");
  expect(existsSync(log) ? readFileSync(log, "utf8").trim() : "").toBe(""); // danger-gated -> no kill
});

test("a heavy proc BELOW the runaway size is spared even under danger", () => {
  // 5G < 12G runaway floor; compressor danger present
  const ps = psFixture([
    `7005 ${KB(5)} /opt/homebrew/.../python3.11 modest.py`,
  ]);
  const { killed } = runGuardian(ps, DANGER(), { HEAVY_ML_RUNAWAY_GB: "12" });
  expect(killed).toBe("");
});
