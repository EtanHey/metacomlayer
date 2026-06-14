import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const repoRoot = process.cwd();

type RunOptions = {
  home: string;
  input?: string;
  env?: Record<string, string>;
};

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), "clx-auto-index-home-"));
  await mkdir(join(home, ".local/share/orc"), { recursive: true });
  return home;
}

async function tempJsonl(lines: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "clx-auto-index-src-"));
  const path = join(dir, "events.jsonl");
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

async function jsonlLineCount(path: string) {
  const text = await readFile(path, "utf8");
  return text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").filter(Boolean).length;
}

async function runScript(script: string, args: string[], options: RunOptions) {
  const proc = Bun.spawn({
    cmd: ["bun", join(repoRoot, script), ...args],
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: options.home,
      ...options.env,
    },
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.input !== undefined) {
    proc.stdin.write(options.input);
    proc.stdin.end();
  }
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

function readRows(home: string, topic: string) {
  const db = new Database(dbPath(home), { readonly: true });
  try {
    return db
      .query(
        "select seq, ts, topic, type, payload_json from events where topic = ? order by seq",
      )
      .all(topic) as Array<{
      seq: number;
      ts: string;
      topic: string;
      type: string;
      payload_json: string;
    }>;
  } finally {
    db.close();
  }
}

describe("clx fleet auto-index scripts", () => {
  test("backfills cmux-agent events once, preserving source timestamps in payload and advancing a marker cursor", async () => {
    const home = await tempHome();
    const source = await tempJsonl([
      {
        ts: "2026-04-01T07:18:12.255Z",
        agent_id: "agent-a",
        event: "created",
        from_state: null,
        to_state: "booting",
      },
      {
        ts: "2026-04-01T07:18:16.954Z",
        agent_id: "agent-a",
        event: "error",
        error: "Surface surface:32 disappeared",
      },
      {
        ts: "2026-04-01T07:20:16.257Z",
        agent_id: "agent-b",
        event: "ready",
      },
    ]);
    const sourceLineCount = await jsonlLineCount(source);

    const first = await runScript(
      "scripts/backfill-cmux-events.ts",
      ["--source", source],
      { home },
    );

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain(`"sourceLineCount":${sourceLineCount}`);
    expect(first.stdout).toContain(`"imported":${sourceLineCount}`);
    const rows = readRows(home, "fleet.cmux-agents");
    expect(rows).toHaveLength(sourceLineCount);
    const payload = JSON.parse(rows[0]!.payload_json);
    expect(rows[0]!.ts).not.toBe(payload.ts);
    expect(payload.ts).toBe("2026-04-01T07:18:12.255Z");
    expect(payload.backfilled).toBe(true);
    expect(payload.source_artifact).toBe("cmux-agents/events.jsonl");
    expect(payload.source_line_count).toBe(sourceLineCount);

    const cursorPath = join(
      home,
      ".local/share/orc/markers/cmux-agents-events.cursor",
    );
    expect(existsSync(cursorPath)).toBe(true);
    const cursor = JSON.parse(await readFile(cursorPath, "utf8"));
    expect(cursor.next_line).toBe(4);
    expect(cursor.source_line_count).toBe(sourceLineCount);

    const markerBefore = (await stat(cursorPath)).mtimeMs;
    await Bun.sleep(20);
    const second = await runScript(
      "scripts/backfill-cmux-events.ts",
      ["--source", source],
      { home },
    );

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('"imported":0');
    expect(readRows(home, "fleet.cmux-agents")).toHaveLength(sourceLineCount);
    expect((await stat(cursorPath)).mtimeMs).toBeGreaterThan(markerBefore);
  });

  test("live adapters shell clx append and preserve provenance for stalker and cmux-agent rows", async () => {
    const home = await tempHome();
    const cmuxSource = await tempJsonl([
      {
        ts: "2026-06-13T10:00:00.000Z",
        agent_id: "agent-live",
        event: "state_changed",
      },
    ]);

    const cmux = await runScript(
      "scripts/cmux-events-tail.ts",
      ["--source", cmuxSource, "--once"],
      { home },
    );
    expect(cmux.exitCode).toBe(0);
    expect(cmux.stdout).toContain('"appended":1');

    const stalker = await runScript(
      "scripts/stalker-clx.ts",
      ["--type", "capture"],
      {
        home,
        input: JSON.stringify({
          captured_at: "2026-06-13T10:01:00.000Z",
          artifact: "docs.local/stalker/frame.png",
        }),
      },
    );
    expect(stalker.exitCode).toBe(0);

    const cmuxRows = readRows(home, "fleet.cmux-agents");
    expect(JSON.parse(cmuxRows.at(-1)!.payload_json)).toMatchObject({
      backfilled: false,
      source_artifact: "cmux-agents/events.jsonl",
      event: "state_changed",
    });
    const stalkerRows = readRows(home, "fleet.stalker");
    expect(JSON.parse(stalkerRows.at(-1)!.payload_json)).toMatchObject({
      backfilled: false,
      source_artifact: "stalker",
      captured_at: "2026-06-13T10:01:00.000Z",
      artifact: "docs.local/stalker/frame.png",
    });

    const tail = Bun.spawnSync({
      cmd: [
        "bun",
        "run",
        "clx",
        "tail",
        "--topic",
        "fleet.stalker",
        "--db",
        dbPath(home),
      ],
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(tail.exitCode).toBe(0);
    expect(tail.stdout.toString()).toContain("docs.local/stalker/frame.png");
  });

  test("signal-capture replays SIGTTIN, tty suspend, and workspace-not-found fixtures as fleet.signal root-cause rows", async () => {
    const home = await tempHome();
    const fixture = await tempJsonl([
      { stderr: "SIGTTIN received while reading terminal" },
      { stderr: "zsh: suspended (tty input) codex" },
      {
        message: "Workspace-not-found",
        workspace: "workspace:missing",
      },
    ]);

    const result = await runScript(
      "scripts/signal-capture.ts",
      ["--fixture", fixture],
      { home },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"captured":3');
    const rows = readRows(home, "fleet.signal");
    expect(rows.map((row) => row.type)).toEqual([
      "signal.sigttin",
      "signal.tty-suspend",
      "signal.workspace-not-found",
    ]);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      root_cause_shape: "wf4-F30",
      signal_class: "SIGTTIN",
      source_artifact: "signal-capture",
    });
  });

  test("auto-index scripts do not use MCP, brain_subscribe, or removed clx verbs", async () => {
    const scripts = await Promise.all(
      [
        "scripts/backfill-cmux-events.ts",
        "scripts/cmux-events-tail.ts",
        "scripts/stalker-clx.ts",
        "scripts/signal-capture.ts",
      ].map(async (script) => readFile(join(repoRoot, script), "utf8")),
    );
    const source = scripts.join("\n");
    expect(source).not.toContain("brain_subscribe");
    expect(source).not.toMatch(/\b(query|write)\b/);
    expect(source).toContain("append");
  });
});
