#!/usr/bin/env bun
/**
 * clx boot — CLI. Wired as `clx-boot` (package.json); folds into `clx boot` as a subcommand later.
 *
 *   clx-boot boot <seat-file.json> [--mcp-stdin | --list-cmd "<cmd>"]
 *                                  [--observed-model <id> | --session-jsonl <path>] [--json]
 *   clx-boot roster [--json]
 *
 * Gate 1 (MCP) + 2 (model-pin) from core; gate 3 appends a `seat.register` row to the SAME
 * journal the spine uses (path-contained); gate 4 points at `clx resume <seat>` (existing).
 * Exit 0 = all gates pass; 1 = a BLOCKER (named, never silently degraded); 2 = usage.
 */
import { Database } from "bun:sqlite";
import { resolve, isAbsolute, relative } from "node:path";
import { homedir } from "node:os";
import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import {
  parseSeatFile,
  observeModel,
  bootVerdict,
  formatRoster,
  type ModelObservation,
  type SeatRow,
} from "./core";

function orcBase() {
  return resolve(homedir(), ".local/share/orc");
}
// SQLITE_PATH_CONTAINMENT (same guard class as the spine): DB must live under ~/.local/share/orc.
function assertContained(path: string): string {
  const base = orcBase();
  const abs = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new CliError(
      "SQLITE_PATH_CONTAINMENT",
      `JOURNAL_DB must be under ${base}: ${path}`,
      1,
    );
  }
  return abs;
}

class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode: number,
  ) {
    super(message);
  }
}

function dbPath(): string {
  return assertContained(
    process.env.JOURNAL_DB ?? resolve(orcBase(), "fleet-journal.db"),
  );
}

async function openDb(): Promise<Database> {
  await mkdir(orcBase(), { recursive: true });
  const db = new Database(dbPath());
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(
    `CREATE TABLE IF NOT EXISTS events (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       ts TEXT NOT NULL, topic TEXT NOT NULL, seat TEXT,
       type TEXT NOT NULL, payload_json TEXT NOT NULL,
       ack_state TEXT NOT NULL DEFAULT 'none'
     );`,
  );
  return db;
}

function appendEvent(
  db: Database,
  topic: string,
  seat: string | null,
  type: string,
  payload: unknown,
): number {
  const ts = new Date().toISOString(); // server-stamped
  const row = db
    .query(
      "INSERT INTO events (ts, topic, seat, type, payload_json) VALUES (?,?,?,?,?) RETURNING seq",
    )
    .get(ts, topic, seat, type, JSON.stringify(payload)) as { seq: number };
  return row.seq;
}

// ── model-observation source resolution (per-harness; Claude JSONL is the reference impl) ──
async function newestSessionJsonl(): Promise<string | null> {
  try {
    const projects = resolve(homedir(), ".claude/projects");
    let best: { path: string; mtime: number } | null = null;
    for (const proj of await readdir(projects)) {
      const dir = resolve(projects, proj);
      for (const f of await readdir(dir).catch(() => [])) {
        if (!f.endsWith(".jsonl")) continue;
        const p = resolve(dir, f);
        const m = (await stat(p)).mtimeMs;
        if (!best || m > best.mtime) best = { path: p, mtime: m };
      }
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

async function resolveObservation(opts: {
  observedModel?: string;
  sessionJsonl?: string;
}): Promise<ModelObservation> {
  if (opts.observedModel)
    return { model: opts.observedModel, refusalFallback: false };
  const path = opts.sessionJsonl ?? (await newestSessionJsonl());
  if (!path) return { model: null, refusalFallback: false };
  try {
    return observeModel(await readFile(path, "utf8"));
  } catch {
    return { model: null, refusalFallback: false };
  }
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function getMcpListing(args: string[]): Promise<string> {
  if (args.includes("--mcp-stdin")) return await Bun.stdin.text();
  const cmd = getFlag(args, "--list-cmd") ?? "claude mcp list";
  const proc = Bun.spawnSync(["sh", "-c", cmd]);
  return new TextDecoder().decode(proc.stdout);
}

async function cmdBoot(args: string[]): Promise<number> {
  const seatPath = args.find((a) => !a.startsWith("--") && a !== "boot");
  if (!seatPath)
    throw new CliError("CLX_BOOT_USAGE", "boot requires <seat-file.json>", 2);
  const seat = parseSeatFile(await readFile(seatPath, "utf8"));
  const mcpListing = await getMcpListing(args);
  const observed = await resolveObservation({
    observedModel: getFlag(args, "--observed-model"),
    sessionJsonl: getFlag(args, "--session-jsonl"),
  });
  const verdict = bootVerdict({ seat, mcpListing, observed });

  const db = await openDb();
  if (verdict.ok) {
    appendEvent(db, "seat", seat.seat, "seat.register", {
      role: seat.role,
      channel: seat.channel,
      monitor_task_id: seat.monitor_task_id,
      pinned_model: seat.pinned_model,
      ...(seat.parent ? { parent: seat.parent } : {}),
    });
  } else if (!verdict.gates.model.ok && observed.model !== null) {
    // gate-2 alarm row (R-041 ledger): record the drift even though boot is blocked
    appendEvent(db, "seat", seat.seat, "drift", {
      observed: verdict.gates.model.observed,
      pinned: verdict.gates.model.pinned,
      refusalFallback: verdict.gates.model.refusalFallback,
    });
  }
  db.close();

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(verdict) + "\n");
  } else if (verdict.ok) {
    process.stdout.write(
      `clx boot ✓ ${seat.seat} (${seat.role}) registered → monitor=${seat.monitor_task_id}, model=${seat.pinned_model}\n` +
        `  gate1 MCP ✓  gate2 model ✓  gate3 seat.register ✓  gate4 → run: clx resume ${seat.seat}\n`,
    );
  } else {
    process.stderr.write(
      `clx boot ✗ ${seat.seat} BLOCKED:\n` +
        verdict.blockers.map((b) => `  - ${b}`).join("\n") +
        "\n",
    );
  }
  return verdict.ok ? 0 : 1;
}

async function cmdRoster(args: string[]): Promise<number> {
  const db = await openDb();
  const rows = db
    .query(
      "SELECT seat, payload_json, ts FROM events WHERE type='seat.register' ORDER BY seq",
    )
    .all() as Array<{ seat: string; payload_json: string; ts: string }>;
  db.close();
  const seatRows: SeatRow[] = rows.map((r) => {
    const p = JSON.parse(r.payload_json);
    return {
      seat: r.seat,
      role: p.role ?? "?",
      channel: p.channel ?? "?",
      monitor_task_id: p.monitor_task_id ?? "none",
      pinned_model: p.pinned_model ?? "?",
      ts: r.ts,
      parent: p.parent,
    };
  });
  if (args.includes("--json")) {
    const latest = new Map<string, SeatRow>();
    for (const r of seatRows)
      if (!latest.has(r.seat) || r.ts >= latest.get(r.seat)!.ts)
        latest.set(r.seat, r);
    process.stdout.write(JSON.stringify([...latest.values()]) + "\n");
  } else {
    process.stdout.write(
      (formatRoster(seatRows) || "(no seats registered)") + "\n",
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  try {
    if (verb === "boot") return await cmdBoot(argv);
    if (verb === "roster") return await cmdRoster(argv);
    process.stderr.write(
      "CLX_BOOT_USAGE: clx-boot <boot <seat-file.json> | roster>\n",
    );
    return 2;
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));
