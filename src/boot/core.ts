/**
 * clx boot — harness-agnostic seat-boot contract (core, pure logic).
 *
 * Gates (SPEC clx-boot-seat-contract-SPEC.md):
 *   1. MCP presence assert  → reuses E3 mcp-preflight `evaluate()`
 *   2. model-pin assert     → observed model == pinned + no refusal-fallback drift (R-041)
 *   3. seat registration    → seat.register journal row (write path lives in cli.ts)
 *   4. rehydrate emit        → `clx resume <seat>` (existing; cli.ts references it)
 *
 * Seat-file format = JSON for the MVP (SPEC open-Q1 build-time default; TOML/frontmatter deferred).
 * This module is pure + side-effect-free so the gates are unit-testable from fixtures.
 */
import { z } from "zod";
import { evaluate } from "../preflight/core";

export const SeatFileSchema = z.object({
  seat: z.string().min(1),
  role: z.enum(["orc", "lead", "ic", "worker"]),
  channel: z.string().min(1),
  pinned_model: z.string().min(1),
  require_mcp: z.array(z.string()).default([]),
  monitor_task_id: z.string().default("none"),
  parent: z.string().optional(),
});
export type SeatFile = z.infer<typeof SeatFileSchema>;

/** Parse + validate a JSON seat-file. Throws on malformed/incomplete (never a silent default). */
export function parseSeatFile(text: string): SeatFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`CLX_BOOT_SEATFILE_JSON: ${(error as Error).message}`);
  }
  const parsed = SeatFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `CLX_BOOT_SEATFILE_INVALID: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

export interface ModelObservation {
  model: string | null;
  refusalFallback: boolean;
}

/**
 * Observe the running model from a session JSONL (skillCreator's mechanism, SPEC gate 2):
 *   observed = last assistant message's `.message.model`
 *   refusalFallback = any `subtype === "model_refusal_fallback"` system row present
 * Tolerates blank/garbage lines (a partial JSONL must not crash boot).
 */
export function observeModel(jsonl: string): ModelObservation {
  let model: string | null = null;
  let refusalFallback = false;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row: any;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (row?.subtype === "model_refusal_fallback") refusalFallback = true;
    const m = row?.message?.model;
    if (typeof m === "string" && m.length > 0) model = m;
  }
  return { model, refusalFallback };
}

export interface BootVerdict {
  ok: boolean;
  gates: {
    mcp: { ok: boolean; missing: string[]; disconnected: string[] };
    model: {
      ok: boolean;
      observed: string | null;
      pinned: string;
      refusalFallback: boolean;
    };
  };
  blockers: string[];
}

/** Compose gates 1 (MCP) + 2 (model-pin) into a verdict. Pure; cli.ts handles I/O + gate 3/4. */
export function bootVerdict(input: {
  seat: Pick<SeatFile, "pinned_model" | "require_mcp">;
  mcpListing: string;
  observed: ModelObservation;
}): BootVerdict {
  const blockers: string[] = [];

  const mcp = evaluate(input.seat.require_mcp ?? [], input.mcpListing);
  if (!mcp.ok) {
    for (const m of mcp.missing) blockers.push(`MCP_MISSING: ${m}`);
    for (const d of mcp.disconnected) blockers.push(`MCP_DISCONNECTED: ${d}`);
  }

  const pinned = input.seat.pinned_model;
  const observed = input.observed.model;
  const modelMatches = observed !== null && observed === pinned;
  const modelOk = modelMatches && !input.observed.refusalFallback;
  if (observed === null) {
    blockers.push(
      `MODEL_UNOBSERVED: cannot confirm running model == pinned ${pinned}`,
    );
  } else if (!modelMatches) {
    blockers.push(`MODEL_DRIFT: observed ${observed} != pinned ${pinned}`);
  }
  if (input.observed.refusalFallback) {
    blockers.push(
      `MODEL_REFUSAL_FALLBACK: a model_refusal_fallback row is present (R-041 sticky-drift risk)`,
    );
  }

  return {
    ok: blockers.length === 0,
    gates: {
      mcp: { ok: mcp.ok, missing: mcp.missing, disconnected: mcp.disconnected },
      model: {
        ok: modelOk,
        observed,
        pinned,
        refusalFallback: input.observed.refusalFallback,
      },
    },
    blockers,
  };
}

export interface SeatRow {
  seat: string;
  role: string;
  channel: string;
  monitor_task_id: string;
  pinned_model: string;
  ts: string;
  parent?: string;
}

/** Latest-per-seat roster (gate 3 read path = `clx roster`). Most-recent ts wins per seat. */
export function formatRoster(rows: SeatRow[]): string {
  const latest = new Map<string, SeatRow>();
  for (const row of rows) {
    const prev = latest.get(row.seat);
    if (!prev || row.ts >= prev.ts) latest.set(row.seat, row);
  }
  return [...latest.values()]
    .sort((a, b) => a.seat.localeCompare(b.seat))
    .map(
      (r) =>
        `${r.seat}  role=${r.role}  channel=${r.channel}  model=${r.pinned_model}  monitor=${r.monitor_task_id}${r.parent ? `  parent=${r.parent}` : ""}`,
    )
    .join("\n");
}
