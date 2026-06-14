import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const CMUX_TOPIC = "fleet.cmux-agents";
export const STALKER_TOPIC = "fleet.stalker";
export const SIGNAL_TOPIC = "fleet.signal";
export const CMUX_SOURCE_ARTIFACT = "cmux-agents/events.jsonl";
export const MAX_CLX_PAYLOAD_BYTES = 64 * 1024;

export type Cursor = {
  source: string;
  next_line: number;
  source_line_count: number;
  updated_at: string;
};

export function orcBase(home = process.env.HOME) {
  if (!home) throw new Error("HOME is required");
  return join(home, ".local/share/orc");
}

export function markerPath(name: string, home = process.env.HOME) {
  return join(orcBase(home), "markers", name);
}

export async function loadCursor(path: string): Promise<Cursor | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Cursor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveCursor(path: string, cursor: Cursor) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cursor)}\n`);
}

export async function readJsonLines(path: string) {
  const text = await readFile(path, "utf8");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  return lines;
}

export function parseLine(line: string) {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { raw: line };
  }
}

export function withCmuxProvenance(
  row: Record<string, unknown>,
  options: { backfilled: boolean; line: number; sourceLineCount: number },
) {
  return fitPayload({
    ...row,
    backfilled: options.backfilled,
    source_artifact: CMUX_SOURCE_ARTIFACT,
    source_line: options.line,
    source_line_count: options.sourceLineCount,
  });
}

export function fitPayload(payload: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_CLX_PAYLOAD_BYTES) {
    return payload;
  }
  const originalTs = typeof payload.ts === "string" ? payload.ts : undefined;
  const compact = {
    ts: originalTs,
    backfilled: payload.backfilled,
    source_artifact: payload.source_artifact,
    source_line: payload.source_line,
    source_line_count: payload.source_line_count,
    truncated: true,
    original_payload_bytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
  };
  return compact;
}

export async function clxAppend(topic: string, type: string, payload: unknown) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "clx", "append", topic, type, JSON.stringify(payload)],
    cwd: resolve(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      JOURNAL_DB: process.env.JOURNAL_DB,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`clx append failed (${exitCode}): ${stderr || stdout}`);
  }
  return JSON.parse(stdout.slice(stdout.lastIndexOf("{"))) as { ok: true; seq: number };
}

export function eventType(row: Record<string, unknown>, fallback: string) {
  return typeof row.event === "string" && row.event.length > 0 ? row.event : fallback;
}

export async function readStdin() {
  return await new Response(Bun.stdin.stream()).text();
}
