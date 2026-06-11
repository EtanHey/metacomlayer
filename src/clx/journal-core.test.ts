import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const CLI = [join(process.cwd(), "src/clx/cli.ts")];

type RunOptions = {
  home: string;
  cwd?: string;
  env?: Record<string, string>;
};

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), "clx-home-"));
  await mkdir(join(home, ".local/share/orc"), { recursive: true });
  return home;
}

async function runClx(args: string[], options: RunOptions) {
  const proc = Bun.spawn({
    cmd: ["bun", ...CLI, ...args],
    cwd: options.cwd ?? process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: options.home,
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function dbPath(home: string) {
  return join(home, ".local/share/orc/fleet-journal.db");
}

function readEvents(dbFile: string) {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db
      .query(
        "select seq, ts, topic, seat, type, payload_json, ack_state from events order by seq",
      )
      .all() as Array<{
      seq: number;
      ts: string;
      topic: string;
      seat: string | null;
      type: string;
      payload_json: string;
      ack_state: string;
    }>;
  } finally {
    db.close();
  }
}

beforeAll(() => {
  expect(import.meta.dir.endsWith("/src/clx")).toBe(true);
});

describe("clx journal-core CLI", () => {
  test("boot registers a seat through the clx entrypoint", async () => {
    const home = await tempHome();
    const customDb = join(home, ".local/share/orc/clx-boot-fold.db");
    const seatFile = join(home, "seat.json");
    await writeFile(
      seatFile,
      JSON.stringify({
        seat: "clxBootFold",
        role: "worker",
        channel: "gen-16",
        pinned_model: "claude-opus-4-8[1m]",
        monitor_task_id: "monitor-123",
        require_mcp: ["cmux", "brainlayer"],
      }),
    );

    const result = await runClx(
      [
        "boot",
        seatFile,
        "--db",
        customDb,
        "--list-cmd",
        "printf 'cmux: bun - ✔ Connected\\nbrainlayer: bun - ✔ Connected\\n'",
        "--observed-model",
        "claude-opus-4-8[1m]",
      ],
      { home },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("clx boot ✓ clxBootFold");
    const events = readEvents(customDb);
    expect(events.length).toBeGreaterThan(0);
    const event = events.at(-1)!;
    expect(event.type).toBe("seat.register");
    expect(event.seat).toBe("clxBootFold");
    expect(JSON.parse(event.payload_json).monitor_task_id).toBe("monitor-123");
  });

  test("roster lists seats through the clx entrypoint", async () => {
    const home = await tempHome();
    const customDb = join(home, ".local/share/orc/clx-roster-fold.db");
    const seatFile = join(home, "seat.json");
    await writeFile(
      seatFile,
      JSON.stringify({
        seat: "clxRosterFold",
        role: "worker",
        channel: "gen-16",
        pinned_model: "claude-opus-4-8[1m]",
        monitor_task_id: "monitor-456",
        require_mcp: ["cmux", "brainlayer"],
      }),
    );
    const bootResult = await runClx(
      [
        "boot",
        seatFile,
        "--db",
        customDb,
        "--list-cmd",
        "printf 'cmux: bun - ✔ Connected\\nbrainlayer: bun - ✔ Connected\\n'",
        "--observed-model",
        "claude-opus-4-8[1m]",
      ],
      { home },
    );
    expect(bootResult.exitCode).toBe(0);

    const result = await runClx(["roster", "--db", customDb], { home });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("clxRosterFold");
    expect(result.stdout).toContain("monitor-456");
  });

  test("seeds the spine ruling, parks, emits, and resumes late arrivals from a copied DB in a fresh cwd", async () => {
    const home = await tempHome();
    const park = await runClx(
      ["park", "demo", "--brief", "resume at step 3: canary list half-built"],
      { home },
    );
    expect(park.exitCode).toBe(0);
    const emit = await runClx(
      ["emit", "demo.note", JSON.stringify({ late: "arrived after park" })],
      { home },
    );
    expect(emit.exitCode).toBe(0);

    const resume = await runClx(["resume", "demo"], { home });
    expect(resume.exitCode).toBe(0);
    expect(resume.stdout).toContain(
      "resume at step 3: canary list half-built",
    );
    expect(resume.stdout).toContain("LATE ARRIVALS(1)");
    expect(resume.stdout).toContain('"late":"arrived after park"');
    expect(resume.stdout).toContain("journal_seq_watermark: 2");

    const otherHome = await tempHome();
    const otherCwd = await mkdtemp(join(tmpdir(), "clx-cwd-"));
    const copiedDb = join(otherHome, ".local/share/orc/copied-journal.db");
    await copyFile(dbPath(home), copiedDb);
    const copiedResume = await runClx(["resume", "demo", "--db", copiedDb], {
      home: otherHome,
      cwd: otherCwd,
    });
    expect(copiedResume.exitCode).toBe(0);
    expect(copiedResume.stdout).toBe(resume.stdout);

    const events = readEvents(dbPath(home));
    expect(events).toHaveLength(3);
    expect(events[0]!.seq).toBe(1);
    expect(events[0]!.type).toBe("decision");
    expect(JSON.parse(events[0]!.payload_json).ruling).toContain(
      "ONE journal. clx journal-core",
    );
  });

  test("server-stamps ts and ignores client-supplied timestamps", async () => {
    const home = await tempHome();
    const before = Date.now();
    const result = await runClx(
      [
        "append",
        "demo",
        "note",
        JSON.stringify({ ts: "1999-01-01T00:00:00.000Z", ok: true }),
      ],
      { home },
    );
    const after = Date.now();
    expect(result.exitCode).toBe(0);

    const event = readEvents(dbPath(home)).at(-1)!;
    expect(event.ts).not.toBe("1999-01-01T00:00:00.000Z");
    expect(Date.parse(event.ts)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(event.ts)).toBeLessThanOrEqual(after);
    expect(JSON.parse(event.payload_json).ts).toBe("1999-01-01T00:00:00.000Z");
  });

  test("parallel append processes land all rows with strictly monotonic seq values", async () => {
    const home = await tempHome();
    const count = 16;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        runClx(
          ["append", "parallel", "note", JSON.stringify({ index: i })],
          { home },
        ),
      ),
    );
    expect(results.every((r) => r.exitCode === 0)).toBe(true);

    const rows = readEvents(dbPath(home)).filter(
      (event) => event.topic === "parallel",
    );
    expect(rows).toHaveLength(count);
    const seqs = rows.map((row) => row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(count);
  });

  test("tail resumes from a seq watermark and can filter by topic", async () => {
    const home = await tempHome();
    await runClx(["emit", "alpha", JSON.stringify({ n: 1 })], { home });
    await runClx(["emit", "beta", JSON.stringify({ n: 2 })], { home });
    const alpha = await runClx(["tail", "--topic", "alpha", "--since", "2"], {
      home,
    });
    expect(alpha.exitCode).toBe(0);
    expect(alpha.stdout).toContain('"topic":"alpha"');
    expect(alpha.stdout).not.toContain('"topic":"beta"');
  });

  test("marker fan-out touches the derived topic marker after commit", async () => {
    const home = await tempHome();
    const marker = join(home, ".local/share/orc/markers/demo_note");
    const first = await runClx(
      ["emit", "demo.note", JSON.stringify({ n: 1 })],
      { home },
    );
    expect(first.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    const firstMtime = statSync(marker).mtimeMs;

    await Bun.sleep(20);
    const second = await runClx(
      ["emit", "demo.note", JSON.stringify({ n: 2 })],
      { home },
    );
    expect(second.exitCode).toBe(0);
    expect(statSync(marker).mtimeMs).toBeGreaterThan(firstMtime);

    const markerText = await readFile(marker, "utf8");
    expect(Number(markerText.trim())).toBeGreaterThan(1);
  });

  test("rejects JOURNAL_DB paths outside the allowlisted orc data directory", async () => {
    const home = await tempHome();
    const result = await runClx(
      ["append", "x", "note", JSON.stringify({})],
      { home, env: { JOURNAL_DB: "/etc/evil.sqlite3" } },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("SQLITE_PATH_CONTAINMENT");
  });

  test("rejects oversized JSON payloads before writing an event", async () => {
    const home = await tempHome();
    const result = await runClx(
      ["append", "x", "note", JSON.stringify({ body: "x".repeat(70 * 1024) })],
      { home },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("CLX_PAYLOAD_TOO_LARGE");
    expect(readEvents(dbPath(home))).toHaveLength(1);
  });

  test("resume on a missing seat returns a named not-found error", async () => {
    const home = await tempHome();
    const result = await runClx(["resume", "missing"], { home });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("CLX_NOT_FOUND");
    expect(result.stderr).toContain("missing");
  });

  test("resume uses the latest park event for a seat", async () => {
    const home = await tempHome();
    await runClx(["park", "demo", "--brief", "first park"], { home });
    await runClx(["park", "demo", "--brief", "second park"], { home });

    const resume = await runClx(["resume", "demo"], { home });
    expect(resume.exitCode).toBe(0);
    expect(resume.stdout).toContain("second park");
    expect(resume.stdout).not.toContain("first park");
  });

  test("source keeps events append-only by exposing no UPDATE or DELETE event-row path", async () => {
    const source = await readFile(join(import.meta.dir, "cli.ts"), "utf8");
    expect(source).not.toMatch(/\bUPDATE\s+events\b/i);
    expect(source).not.toMatch(/\bDELETE\s+FROM\s+events\b/i);
  });
});
