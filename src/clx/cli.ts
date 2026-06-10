import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const SPINE_RULING =
  "ONE journal. clx journal-core (append / marker fan-out / tail) + the `clx` CLI = controllayer-mcl deliverable. orc PR-J1 = the consumer layer (board/at-risk/deliverables/rehydrate/verify + G-board seed) + ledger POLICY + P4 gh-verify. DB = ~/.local/share/orc/fleet-journal.db, standalone WAL. Push primitive = write-side marker files + native CC Monitor (NOT brain_subscribe — those are notImplemented stubs). No journal PR before controllayer's in-channel ack (posted 2026-06-10 19:48 IDT).";

type EventRow = {
  seq: number;
  ts: string;
  topic: string;
  seat: string | null;
  type: string;
  payload_json: string;
  ack_state: string;
};

class CliError extends Error {
  constructor(
    readonly name: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

function homeDir() {
  const home = process.env.HOME;
  if (!home) {
    throw new CliError("SQLITE_PATH_CONTAINMENT", "HOME is required");
  }
  return home;
}

function orcBase() {
  return resolve(homeDir(), ".local/share/orc");
}

function assertContained(path: string, label: string) {
  const base = orcBase();
  const resolved = resolve(path);
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new CliError(
      "SQLITE_PATH_CONTAINMENT",
      `${label} must be under ${base}: ${resolved}`,
    );
  }
  return resolved;
}

function parseGlobalArgs(argv: string[]) {
  const args = [...argv];
  let db = process.env.JOURNAL_DB ?? resolve(orcBase(), "fleet-journal.db");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db") {
      const value = args[i + 1];
      if (!value) throw new CliError("CLX_USAGE", "--db requires a path");
      db = value;
      args.splice(i, 2);
      i--;
    }
  }
  return { args, dbPath: assertContained(db, "JOURNAL_DB") };
}

async function preparePaths(dbPath: string) {
  const markersDir = assertContained(resolve(orcBase(), "markers"), "markers");
  await mkdir(dirname(dbPath), { recursive: true });
  await mkdir(markersDir, { recursive: true });
  return { markersDir };
}

function isBusy(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("SQLITE_BUSY") ||
      error.message.toLowerCase().includes("database is locked"))
  );
}

async function withBusyRetry<T>(operation: () => T | Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isBusy(error) || attempt === 5) throw error;
      last = error;
      await Bun.sleep(15 * (attempt + 1));
    }
  }
  throw last;
}

async function openDb(dbPath: string) {
  return withBusyRetry(() => {
    const db = new Database(dbPath);
    try {
      db.exec("PRAGMA busy_timeout=5000;");
      db.exec("PRAGMA journal_mode=WAL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          seq          INTEGER PRIMARY KEY AUTOINCREMENT,
          ts           TEXT NOT NULL,
          topic        TEXT NOT NULL,
          seat         TEXT,
          type         TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          ack_state    TEXT NOT NULL DEFAULT 'none'
        );
      `);
      seedSpineRuling(db);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  });
}

function seedSpineRuling(db: Database) {
  db.query(
    `INSERT OR IGNORE INTO events
      (seq, ts, topic, seat, type, payload_json, ack_state)
      VALUES (1, ?, 'spine', NULL, 'decision', ?, 'none')`,
  ).run(new Date().toISOString(), JSON.stringify({ ruling: SPINE_RULING }));
}

function parseJson(input: string) {
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    throw new CliError(
      "CLX_BAD_JSON",
      error instanceof Error ? error.message : "invalid JSON",
    );
  }
}

function tagForTopic(topic: string) {
  const tag = topic.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return tag || "root";
}

async function touchMarker(markersDir: string, topic: string, seq: number) {
  const markerPath = assertContained(
    resolve(markersDir, tagForTopic(topic)),
    "marker",
  );
  await writeFile(markerPath, `${seq}\n`);
}

async function appendEvent(
  db: Database,
  markersDir: string,
  event: { topic: string; type: string; payload: unknown; seat?: string | null },
) {
  const seq = await withBusyRetry(() => {
    const result = db
      .query(
        `INSERT INTO events (ts, topic, seat, type, payload_json, ack_state)
         VALUES (?, ?, ?, ?, ?, 'none')
         RETURNING seq`,
      )
      .get(
        new Date().toISOString(),
        event.topic,
        event.seat ?? null,
        event.type,
        JSON.stringify(event.payload),
      ) as { seq: number };
    return result.seq;
  });
  await touchMarker(markersDir, event.topic, seq);
  return seq;
}

async function appendPark(
  db: Database,
  markersDir: string,
  seat: string,
  brief: string,
) {
  const payload = await withBusyRetry(() => {
    let row!: { seq: number; payload_json: string };
    db.exec("BEGIN IMMEDIATE;");
    try {
      const next = db
        .query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events")
        .get() as { seq: number };
      const parkPayload = {
        brief,
        snapshot_manifest: {
          jsonl_path: null,
          journal_seq_watermark: next.seq,
          last_user_turn_ts: new Date().toISOString(),
        },
        open_gates: [],
      };
      row = db
        .query(
          `INSERT INTO events (ts, topic, seat, type, payload_json, ack_state)
           VALUES (?, 'seat.park', ?, 'park', ?, 'none')
           RETURNING seq, payload_json`,
        )
        .get(new Date().toISOString(), seat, JSON.stringify(parkPayload)) as {
        seq: number;
        payload_json: string;
      };
      db.exec("COMMIT;");
      return row;
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  });
  await touchMarker(markersDir, "seat.park", payload.seq);
  return payload.seq;
}

function printableRow(row: EventRow) {
  return {
    ...row,
    payload: JSON.parse(row.payload_json) as unknown,
  };
}

function rowsToJsonLines(rows: EventRow[]) {
  return (
    rows.map((row) => JSON.stringify(printableRow(row))).join("\n") +
    (rows.length ? "\n" : "")
  );
}

function latestPark(db: Database, seat: string) {
  return db
    .query(
      `SELECT seq, ts, topic, seat, type, payload_json, ack_state
       FROM events
       WHERE type = 'park' AND seat = ?
       ORDER BY seq DESC
       LIMIT 1`,
    )
    .get(seat) as EventRow | null;
}

function selectEvents(db: Database, options: { topic?: string; since?: number }) {
  if (options.topic) {
    return db
      .query(
        `SELECT seq, ts, topic, seat, type, payload_json, ack_state
         FROM events
         WHERE seq >= ? AND topic = ?
         ORDER BY seq`,
      )
      .all(options.since ?? 1, options.topic) as EventRow[];
  }
  return db
    .query(
      `SELECT seq, ts, topic, seat, type, payload_json, ack_state
       FROM events
       WHERE seq >= ?
       ORDER BY seq`,
    )
    .all(options.since ?? 1) as EventRow[];
}

function parseTailArgs(args: string[]) {
  let topic: string | undefined;
  let since = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--topic") {
      topic = args[++i];
      if (!topic) throw new CliError("CLX_USAGE", "--topic requires a value");
    } else if (args[i] === "--since") {
      const raw = args[++i];
      if (!raw) throw new CliError("CLX_USAGE", "--since requires a value");
      since = Number(raw);
      if (!Number.isInteger(since) || since < 1) {
        throw new CliError("CLX_USAGE", "--since must be a positive integer");
      }
    } else {
      throw new CliError("CLX_USAGE", `unknown tail argument: ${args[i]}`);
    }
  }
  return { topic, since };
}

async function run(argv: string[]) {
  const { args, dbPath } = parseGlobalArgs(argv);
  const verb = args[0];
  if (!verb) throw new CliError("CLX_USAGE", "missing verb");
  const { markersDir } = await preparePaths(dbPath);
  const db = await openDb(dbPath);
  try {
    if (verb === "append") {
      const [topic, type, json] = args.slice(1);
      if (!topic || !type || !json) {
        throw new CliError("CLX_USAGE", "append requires <topic> <type> <json>");
      }
      const seq = await appendEvent(db, markersDir, {
        topic,
        type,
        payload: parseJson(json),
      });
      console.log(JSON.stringify({ ok: true, seq }));
      return;
    }

    if (verb === "emit") {
      const [topic, json] = args.slice(1);
      if (!topic || !json) {
        throw new CliError("CLX_USAGE", "emit requires <topic> <json>");
      }
      const seq = await appendEvent(db, markersDir, {
        topic,
        type: "note",
        payload: parseJson(json),
      });
      console.log(JSON.stringify({ ok: true, seq }));
      return;
    }

    if (verb === "tail") {
      const options = parseTailArgs(args.slice(1));
      process.stdout.write(rowsToJsonLines(selectEvents(db, options)));
      return;
    }

    if (verb === "park") {
      const seat = args[1];
      const briefFlag = args[2];
      const brief = args[3];
      if (!seat || briefFlag !== "--brief" || brief === undefined) {
        throw new CliError("CLX_USAGE", "park requires <seat> --brief <text>");
      }
      const seq = await appendPark(db, markersDir, seat, brief);
      console.log(JSON.stringify({ ok: true, seq }));
      return;
    }

    if (verb === "resume") {
      const seat = args[1];
      if (!seat) throw new CliError("CLX_USAGE", "resume requires <seat>");
      const park = latestPark(db, seat);
      if (!park) throw new CliError("CLX_NOT_FOUND", `no park event for ${seat}`);
      const payload = JSON.parse(park.payload_json) as {
        brief: string;
        snapshot_manifest: { journal_seq_watermark: number };
        open_gates: unknown[];
      };
      const watermark = payload.snapshot_manifest.journal_seq_watermark;
      const late = selectEvents(db, { since: watermark + 1 });
      console.log(`BRIEF`);
      console.log(payload.brief);
      console.log(`journal_seq_watermark: ${watermark}`);
      console.log(`OPEN GATES`);
      console.log(JSON.stringify(payload.open_gates));
      console.log(`LATE ARRIVALS(${late.length})`);
      process.stdout.write(rowsToJsonLines(late));
      return;
    }

    throw new CliError("CLX_USAGE", `unknown verb: ${verb}`);
  } finally {
    db.close();
  }
}

run(Bun.argv.slice(2)).catch((error) => {
  if (error instanceof CliError) {
    console.error(`${error.name}: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
