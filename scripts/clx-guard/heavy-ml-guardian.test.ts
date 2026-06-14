import { test as bunTest, expect, beforeAll } from "bun:test";
// macOS-only: these shell out to memory_pressure/vm_stat/sysctl/date -j. Skip on Linux CI.
const test = process.platform === "darwin" ? bunTest : bunTest.skip;
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = join(import.meta.dir);
const GUARDIAN = join(DIR, "heavy-ml-guardian.sh");
const SLOT = join(DIR, "heavy-ml-slot.sh");

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "clx-guard-"));
});

// --- fixtures -------------------------------------------------------------
const KB = (gb: number) => Math.round(gb * 1024 * 1024);
function psFixture(lines: string[]): string {
  const p = join(work, `ps-${Math.abs(hash(lines.join()))}.txt`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}
function vmstat(compressorPages: number): string {
  const p = join(work, `vmstat-${compressorPages}.txt`);
  writeFileSync(
    p,
    `Mach Virtual Memory Statistics: (page size of 16384 bytes)\n` +
      `Pages free:                          100000.\n` +
      `Pages occupied by compressor:        ${compressorPages}.\n`,
  );
  return p;
}
function vmstatWithWired(compressorPages: number, wiredPages: number): string {
  const p = join(work, `vmstat-wired-${compressorPages}-${wiredPages}.txt`);
  writeFileSync(
    p,
    `Mach Virtual Memory Statistics: (page size of 16384 bytes)\n` +
      `Pages free:                          100000.\n` +
      `Pages wired down:                    ${wiredPages}.\n` +
      `Pages occupied by compressor:        ${compressorPages}.\n`,
  );
  return p;
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++)
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// a fresh sample file whose ts -> epoch we can compute, so NOW_EPOCH controls freshness
const SAMPLE_TS = "2026-06-14T09:00:00+0300";
function sampleFile(): string {
  const p = join(work, "samples.jsonl");
  writeFileSync(
    p,
    `{"ts":"${SAMPLE_TS}","instance":"nightly","pid":1,"compressor_mb":100}\n`,
  );
  return p;
}
function tsEpoch(): number {
  const out = execFileSync("date", [
    "-j",
    "-f",
    "%Y-%m-%dT%H:%M:%S%z",
    SAMPLE_TS,
    "+%s",
  ])
    .toString()
    .trim();
  return parseInt(out, 10);
}

function safeMem(): string {
  const p = join(work, "mem-safe.txt");
  writeFileSync(
    p,
    `The system has memory.\nSystem-wide memory free percentage: 95%\n`,
  );
  return p;
}
function unreadableMem(): string {
  const p = join(work, "mem-unreadable.txt");
  writeFileSync(p, `memory pressure unavailable\n`);
  return p;
}
function safeSwap(): string {
  const p = join(work, "swap-safe.txt");
  writeFileSync(
    p,
    `vm.swapusage: total = 4096.00M  used = 0.00M  free = 4096.00M  (encrypted)\n`,
  );
  return p;
}

function runGuardian(env: Record<string, string>): any {
  const base: Record<string, string> = {
    ...process.env,
    HEAVY_ML_NOTIFY_URL: "http://127.0.0.1:9/notify", // unreachable: no real telegram during tests
    HEAVY_ML_CLX_CLI: "", // no clx emit during tests
    HEAVY_ML_GUARD_ENABLE_KILL: "0",
    HEAVY_ML_MEMPRESSURE_FIXTURE: safeMem(), // deterministic: free RAM healthy
    HEAVY_ML_SWAP_FIXTURE: safeSwap(), // deterministic: no swap
  };
  const out = execFileSync("bash", [GUARDIAN], { env: { ...base, ...env } })
    .toString()
    .trim();
  const lastLine = out.split("\n").filter(Boolean).pop()!;
  return JSON.parse(lastLine);
}

const lowCompressor = () => vmstat(100000); // ~1.5GB < 12GB
const freshEnv = () => ({
  HEAVY_ML_SAMPLE_FILE: sampleFile(),
  HEAVY_ML_NOW_EPOCH: String(tsEpoch() + 60),
});

// --- tests ----------------------------------------------------------------

test("single heavy-ML slot is OK (no trip)", () => {
  const ps = psFixture([
    `1003 ${KB(5)} /opt/homebrew/bin/llama-server -m model.gguf`,
  ]);
  const r = runGuardian({
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: lowCompressor(),
    ...freshEnv(),
  });
  expect(r.heavy_ml_count).toBe(1);
  expect(r.tripped).toBe("");
});

test("two heavy-ML procs trip the mutex (the 14GB python pileup)", () => {
  const ps = psFixture([
    `1001 ${KB(14)} /opt/homebrew/.../python3.11 /Users/x/mlx_infer.py`,
    `1002 ${KB(14)} /opt/homebrew/.../python3.11 /Users/x/pi_model.py`,
  ]);
  const r = runGuardian({
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: lowCompressor(),
    ...freshEnv(),
  });
  expect(r.heavy_ml_count).toBe(2);
  expect(r.tripped).toContain("heavy_ml_mutex");
});

test("aggregate footprint danger trips even with a single proc", () => {
  const ps = psFixture([
    `1001 ${KB(30)} /opt/homebrew/.../python3.11 big_model.py`,
  ]);
  const r = runGuardian({
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: lowCompressor(),
    ...freshEnv(),
  });
  expect(r.heavy_ml_count).toBe(1);
  expect(r.tripped).not.toContain("heavy_ml_mutex");
  expect(r.tripped).toContain("heavy_ml_aggregate");
});

test("compressor over threshold trips (real 16K page size)", () => {
  // 1,000,000 pages * 16384 = ~15.3GB > 12GB
  const ps = psFixture([`1003 ${KB(5)} /opt/homebrew/bin/llama-server`]);
  const r = runGuardian({
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: vmstat(1000000),
    ...freshEnv(),
  });
  expect(Number(r.compressor_gb)).toBeGreaterThan(12);
  expect(r.tripped).toContain("compressor");
});

test("wired memory over threshold trips wired_high and reports wired_gb", () => {
  // 1,600,000 pages * 16384 = ~24.4GB > default 22GB wired danger threshold
  const ps = psFixture([`1003 ${KB(5)} /opt/homebrew/bin/llama-server`]);
  const r = runGuardian({
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: vmstatWithWired(100000, 1600000),
    ...freshEnv(),
  });
  expect(Number(r.wired_gb)).toBeGreaterThan(22);
  expect(r.wired_high).toBe(1);
  expect(r.tripped).toContain("wired_high");
});

test("unreadable free RAM fails closed as low_free_ram danger", () => {
  const ps = psFixture([`1003 ${KB(5)} /opt/homebrew/bin/llama-server`]);
  const r = runGuardian({
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: lowCompressor(),
    HEAVY_ML_MEMPRESSURE_FIXTURE: unreadableMem(),
    ...freshEnv(),
  });
  expect(r.free_ram_pct).toBe(0);
  expect(r.tripped).toContain("low_free_ram");
});

test("stale sampler trips sampler_stale (the Jun-11 silent-death case)", () => {
  const ps = psFixture([`1003 ${KB(5)} /opt/homebrew/bin/llama-server`]);
  const r = runGuardian({
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: lowCompressor(),
    HEAVY_ML_SAMPLE_FILE: sampleFile(),
    HEAVY_ML_NOW_EPOCH: String(tsEpoch() + 100000), // way past the 900s stale window
  });
  expect(r.sampler_fresh).toBe(0);
  expect(r.tripped).toContain("sampler_stale");
});

test("non-ML procs (cmux, claude) are excluded even when large", () => {
  const ps = psFixture([
    `2001 ${KB(8)} /Applications/cmux.app/Contents/MacOS/cmux`,
    `2002 ${KB(5)} claude --dangerously-skip-permissions`,
  ]);
  const r = runGuardian({
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: lowCompressor(),
    ...freshEnv(),
  });
  expect(r.heavy_ml_count).toBe(0);
  expect(r.tripped).toBe("");
});

test("small ML procs below HEAVY_ML_MIN_GB do not count", () => {
  const ps = psFixture([`1004 ${KB(1)} /opt/homebrew/bin/ollama serve`]); // 1GB < 3GB gate
  const r = runGuardian({
    HEAVY_ML_PS_FIXTURE: ps,
    HEAVY_ML_VMSTAT_FIXTURE: lowCompressor(),
    ...freshEnv(),
  });
  expect(r.heavy_ml_count).toBe(0);
});

// --- mutex primitive ------------------------------------------------------

test("slot mutex: with succeeds when free", () => {
  const lock = join(work, "slot-free.lock");
  const env = {
    ...process.env,
    HEAVY_ML_SLOT_LOCK: lock,
    HEAVY_ML_SLOT_WAIT_SECONDS: "0",
  };
  expect(execFileSync("bash", [SLOT, "status"], { env }).toString()).toContain(
    "free",
  );
  expect(() =>
    execFileSync("bash", [SLOT, "with", "true"], { env }),
  ).not.toThrow();
  // released on exit -> free again
  expect(execFileSync("bash", [SLOT, "status"], { env }).toString()).toContain(
    "free",
  );
});

test("slot mutex: with refuses a LIVE concurrent holder (exit 75)", () => {
  const lock = join(work, "slot-live.lock");
  const env = {
    ...process.env,
    HEAVY_ML_SLOT_LOCK: lock,
    HEAVY_ML_SLOT_WAIT_SECONDS: "0",
  };
  // simulate a live holder: lock dir + this (alive) test process pid
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid));
  expect(execFileSync("bash", [SLOT, "status"], { env }).toString()).toContain(
    "held",
  );

  let code = 0;
  try {
    execFileSync("bash", [SLOT, "with", "true"], { env });
  } catch (e: any) {
    code = e.status;
  }
  expect(code).toBe(75); // refused while the holder is alive
  rmSync(lock, { recursive: true, force: true });
});

test("slot mutex: reclaims a stale lock from a DEAD holder (crash resilience)", () => {
  const lock = join(work, "slot-stale.lock");
  const env = {
    ...process.env,
    HEAVY_ML_SLOT_LOCK: lock,
    HEAVY_ML_SLOT_WAIT_SECONDS: "0",
  };
  // a crashed holder left the lock with a pid that is no longer running
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), "999999");
  // with must reclaim and succeed, not deadlock forever
  expect(() =>
    execFileSync("bash", [SLOT, "with", "true"], { env }),
  ).not.toThrow();
});
