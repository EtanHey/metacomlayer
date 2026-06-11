import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { parseSeatFile, observeModel, bootVerdict, formatRoster } from "./core";

// ── gate-3/roster helpers run against a scratch journal under a temp HOME ──
async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), "clxboot-home-"));
  await mkdir(join(home, ".local/share/orc"), { recursive: true });
  return home;
}

const VALID_SEAT = JSON.stringify({
  seat: "controllayerClaude",
  role: "lead",
  channel: "gen-16",
  pinned_model: "claude-opus-4-8[1m]",
  require_mcp: ["cmux", "brainlayer"],
});

describe("clx boot — seat-file (gate data)", () => {
  test("parses a valid JSON seat-file", () => {
    const s = parseSeatFile(VALID_SEAT);
    expect(s.seat).toBe("controllayerClaude");
    expect(s.role).toBe("lead");
    expect(s.pinned_model).toBe("claude-opus-4-8[1m]");
    expect(s.require_mcp).toEqual(["cmux", "brainlayer"]);
  });

  test("rejects a seat-file missing pinned_model (never-fabricate: no silent default)", () => {
    const bad = JSON.stringify({ seat: "x", role: "lead", channel: "g" });
    expect(() => parseSeatFile(bad)).toThrow();
  });

  test("rejects an unknown role", () => {
    const bad = JSON.stringify({
      seat: "x",
      role: "wizard",
      channel: "g",
      pinned_model: "m",
    });
    expect(() => parseSeatFile(bad)).toThrow();
  });
});

describe("clx boot — gate 2 model observer (session JSONL)", () => {
  test("observes the LAST assistant .message.model", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-fable-5" },
      }),
      JSON.stringify({ type: "user", message: { role: "user" } }),
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-4-8[1m]" },
      }),
    ].join("\n");
    const o = observeModel(jsonl);
    expect(o.model).toBe("claude-opus-4-8[1m]");
    expect(o.refusalFallback).toBe(false);
  });

  test("flags a model_refusal_fallback drift row (R-041)", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-fable-5" },
      }),
      JSON.stringify({ type: "system", subtype: "model_refusal_fallback" }),
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-4-8[1m]" },
      }),
    ].join("\n");
    const o = observeModel(jsonl);
    expect(o.refusalFallback).toBe(true);
  });

  test("tolerates blank/garbage lines without throwing", () => {
    const jsonl =
      "\nnot json\n" +
      JSON.stringify({ type: "assistant", message: { model: "m" } });
    expect(observeModel(jsonl).model).toBe("m");
  });
});

describe("clx boot — verdict (gates 1+2 composed)", () => {
  const seat = {
    seat: "controllayerClaude",
    role: "lead" as const,
    channel: "gen-16",
    pinned_model: "claude-opus-4-8[1m]",
    require_mcp: ["cmux", "brainlayer"],
  };
  const goodListing =
    "cmux: bun - ✔ Connected\nbrainlayer: socat - ✔ Connected\n";

  test("all gates pass → ok", () => {
    const v = bootVerdict({
      seat,
      mcpListing: goodListing,
      observed: { model: "claude-opus-4-8[1m]", refusalFallback: false },
    });
    expect(v.ok).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  test("missing MCP → blocker, not ok", () => {
    const v = bootVerdict({
      seat,
      mcpListing: "cmux: bun - ✔ Connected\n",
      observed: { model: "claude-opus-4-8[1m]", refusalFallback: false },
    });
    expect(v.ok).toBe(false);
    expect(v.blockers.join(" ")).toContain("brainlayer");
  });

  test("model drift → blocker names observed vs pinned", () => {
    const v = bootVerdict({
      seat,
      mcpListing: goodListing,
      observed: { model: "claude-fable-5", refusalFallback: false },
    });
    expect(v.ok).toBe(false);
    expect(v.blockers.join(" ")).toMatch(
      /MODEL.*claude-fable-5.*claude-opus-4-8/,
    );
  });

  test("refusal-fallback alone trips the drift gate even if model now matches", () => {
    const v = bootVerdict({
      seat,
      mcpListing: goodListing,
      observed: { model: "claude-opus-4-8[1m]", refusalFallback: true },
    });
    expect(v.ok).toBe(false);
    expect(v.blockers.join(" ")).toContain("REFUSAL_FALLBACK");
  });
});

describe("clx boot — roster (gate 3 read path)", () => {
  test("formats latest-per-seat from seat.register rows", () => {
    const rows = [
      {
        seat: "orc",
        role: "orc",
        channel: "gen-16",
        monitor_task_id: "a",
        pinned_model: "claude-fable-5",
        ts: "2026-06-11T00:00:00Z",
      },
      {
        seat: "controllayerClaude",
        role: "lead",
        channel: "gen-16",
        monitor_task_id: "none",
        pinned_model: "m1",
        ts: "2026-06-11T00:01:00Z",
      },
      {
        seat: "controllayerClaude",
        role: "lead",
        channel: "gen-16",
        monitor_task_id: "bcx349vrx",
        pinned_model: "claude-opus-4-8[1m]",
        ts: "2026-06-11T01:00:00Z",
      },
    ];
    const out = formatRoster(rows);
    // latest controllayer row wins (bcx349vrx), the stale 'none' row is superseded
    expect(out).toContain("bcx349vrx");
    expect(out).not.toContain("monitor_task_id=none");
    expect(out).toContain("orc");
    // one line per distinct seat
    expect(out.trim().split("\n").length).toBe(2);
  });

  test("a seat with monitor=none renders the honesty-contract marker", () => {
    const out = formatRoster([
      {
        seat: "ghost",
        role: "worker",
        channel: "g",
        monitor_task_id: "none",
        pinned_model: "m",
        ts: "2026-06-11T00:00:00Z",
      },
    ]);
    expect(out).toMatch(/ghost.*monitor=none/);
  });
});
