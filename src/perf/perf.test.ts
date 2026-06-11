import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseFreePercentage,
  parseSwapUsedMb,
  parseResidentModels,
  computeTokensPerS,
  buildPerfPayload,
  parseOpenApps,
  buildCliRunPayload,
  buildSysSnapshotPayload,
} from "./core";

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "stamp-perf-home-"));
  chmodSync(home, 0o700);
  return home;
}

function journalPath(home: string): string {
  return join(home, ".local/share/orc/fleet-journal.db");
}

function readEvents(home: string) {
  const db = new Database(journalPath(home), { readonly: true });
  try {
    return db
      .query(
        "select topic, type, payload_json from events order by seq",
      )
      .all() as { topic: string; type: string; payload_json: string }[];
  } finally {
    db.close();
  }
}

function runStampPerf(args: string[], home: string) {
  return Bun.spawnSync(["bun", "src/perf/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
    },
  });
}

describe("perf stamp — system-stat parsers (grounded in real macOS output)", () => {
  test("memory_pressure free percentage", () => {
    expect(parseFreePercentage("System-wide memory free percentage: 88%")).toBe(
      88,
    );
    expect(parseFreePercentage("nonsense")).toBeNull();
  });

  test("vm.swapusage used MB", () => {
    const out =
      "vm.swapusage: total = 7168.00M  used = 6119.06M  free = 1048.94M  (encrypted)";
    expect(parseSwapUsedMb(out)).toBeCloseTo(6119.06, 2);
    expect(parseSwapUsedMb("vm.swapusage: total = 0.00M  used = 0.00M")).toBe(
      0,
    );
    expect(parseSwapUsedMb("garbage")).toBeNull();
  });

  test("resident model processes (mlx/ollama), deduped, [] when none", () => {
    const ps =
      "ollama\nmlx_lm.server\nollama\nzsh\nnode\nmlx_audio.tts.generate";
    const got = parseResidentModels(ps);
    expect(got).toContain("ollama");
    expect(got).toContain("mlx_lm.server");
    expect(got.filter((m) => m === "ollama").length).toBe(1); // deduped
    expect(parseResidentModels("zsh\nnode\nbun")).toEqual([]);
  });

  test("tokens/sec only when both present and duration > 0", () => {
    expect(computeTokensPerS(512, 16)).toBe(32);
    expect(computeTokensPerS(null, 16)).toBeNull();
    expect(computeTokensPerS(512, 0)).toBeNull();
  });

  test("open GUI apps from osascript output", () => {
    expect(parseOpenApps("Finder, Helium, Terminal\n")).toEqual([
      "Finder",
      "Helium",
      "Terminal",
    ]);
    expect(parseOpenApps("")).toEqual([]);
    expect(parseOpenApps("\n\t")).toEqual([]);
    expect(parseOpenApps("System Events got an error")).toEqual([]);
  });
});

describe("perf stamp — payload assembly", () => {
  test("builds a complete local.perf payload", () => {
    const p = buildPerfPayload({
      op: "ollama-graphify",
      model: "qwen2.5-coder:14b",
      chunk_batch: "batch-3",
      duration_s: 16,
      tokens: 512,
      freePct: 88,
      swapUsedMb: 6119.06,
      residentModels: ["ollama"],
    });
    expect(p.op).toBe("ollama-graphify");
    expect(p.model).toBe("qwen2.5-coder:14b");
    expect(p.chunk_batch).toBe("batch-3");
    expect(p.duration_s).toBe(16);
    expect(p.tokens_per_s).toBe(32);
    expect(p.memory_pressure).toBe(88);
    expect(p.swap_used_mb).toBeCloseTo(6119.06, 2);
    expect(p.resident_models).toEqual(["ollama"]);
  });

  test("nulls flow through honestly (never fabricated)", () => {
    const p = buildPerfPayload({
      op: "x",
      model: "m",
      chunk_batch: "b",
      duration_s: 10,
      tokens: null,
      freePct: null,
      swapUsedMb: null,
      residentModels: [],
    });
    expect(p.tokens_per_s).toBeNull();
    expect(p.memory_pressure).toBeNull();
    expect(p.swap_used_mb).toBeNull();
  });

  test("builds a cli.run payload", () => {
    expect(
      buildCliRunPayload({
        agent: "controllayerCodex-observers",
        repo: "metacomlayer",
        durationS: 120,
        outcome: "ok",
      }),
    ).toEqual({
      agent: "controllayerCodex-observers",
      repo: "metacomlayer",
      duration_s: 120,
      outcome: "ok",
    });
  });

  test("builds a sys.snapshot payload with honest nullable stats and open apps", () => {
    expect(
      buildSysSnapshotPayload({
        freePct: 88,
        swapUsedMb: null,
        residentModels: ["ollama"],
        openApps: ["Finder", "Terminal"],
      }),
    ).toEqual({
      memory_pressure: 88,
      swap_used_mb: null,
      resident_models: ["ollama"],
      open_apps: ["Finder", "Terminal"],
    });
  });
});

describe("stamp-perf CLI ledger event families", () => {
  test("cli-run appends cli.run into an isolated journal", () => {
    const home = scratchHome();
    try {
      const result = runStampPerf(
        [
          "cli-run",
          "--agent",
          "controllayerCodex-observers",
          "--repo",
          "metacomlayer",
          "--duration",
          "120",
          "--outcome",
          "ok",
          "--json",
        ],
        home,
      );
      expect(result.exitCode).toBe(0);

      const events = readEvents(home);
      const row = events.find((event) => event.type === "cli.run");
      expect(row?.topic).toBe("cli");
      expect(JSON.parse(row!.payload_json)).toEqual({
        agent: "controllayerCodex-observers",
        repo: "metacomlayer",
        duration_s: 120,
        outcome: "ok",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("snapshot --json appends sys.snapshot into an isolated journal", () => {
    const home = scratchHome();
    try {
      const result = runStampPerf(["snapshot", "--json"], home);
      expect(result.exitCode).toBe(0);

      const stdout = new TextDecoder().decode(result.stdout);
      const emitted = JSON.parse(stdout);
      expect(emitted.seq).toBeNumber();
      expect(emitted.resident_models).toBeArray();
      expect(emitted.open_apps).toBeArray();
      expect(
        emitted.memory_pressure === null ||
          typeof emitted.memory_pressure === "number",
      ).toBe(true);
      expect(
        emitted.swap_used_mb === null || typeof emitted.swap_used_mb === "number",
      ).toBe(true);

      const events = readEvents(home);
      const row = events.find((event) => event.type === "sys.snapshot");
      expect(row?.topic).toBe("sys");
      expect(JSON.parse(row!.payload_json)).toEqual({
        memory_pressure: emitted.memory_pressure,
        swap_used_mb: emitted.swap_used_mb,
        resident_models: emitted.resident_models,
        open_apps: emitted.open_apps,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
