import { describe, expect, test } from "bun:test";
import {
  parseFreePercentage,
  parseSwapUsedMb,
  parseResidentModels,
  computeTokensPerS,
  buildPerfPayload,
} from "./core";

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
});
