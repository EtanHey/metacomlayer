import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { observeModel, type ModelObservation } from "./core";

export interface ObserveInput {
  jsonlPath?: string;
  sessionLogPath?: string;
  observedModel?: string | null;
  homeDir?: string;
}

export type ObserverObservation = ModelObservation & { note?: string };

export interface ModelObserver {
  harness: string;
  observe(input: ObserveInput): Promise<ObserverObservation>;
}

export class ClaudeJsonlObserver implements ModelObserver {
  harness = "claude";

  async observe(input: ObserveInput): Promise<ModelObservation> {
    const path =
      input.jsonlPath ?? (await newestClaudeJsonl(input.homeDir ?? homedir()));
    if (path === null) return { model: null, refusalFallback: false };
    return observeModel(await readFile(path, "utf8"));
  }
}

export class CmuxScreenObserver implements ModelObserver {
  harness = "cmux";

  async observe(input: ObserveInput): Promise<ModelObservation> {
    const model = cleanModel(input.observedModel);
    return { model, refusalFallback: false };
  }
}

export class CodexObserver implements ModelObserver {
  harness = "codex";

  async observe(input: ObserveInput): Promise<ObserverObservation> {
    if (!input.sessionLogPath) {
      return documentedStub("codex");
    }
    return {
      model: parseLastModel(await readFile(input.sessionLogPath, "utf8"), [
        ["payload", "model"],
      ]),
      refusalFallback: false,
    };
  }
}

export class GeminiObserver implements ModelObserver {
  harness = "gemini";

  async observe(input: ObserveInput): Promise<ObserverObservation> {
    if (!input.sessionLogPath) {
      return documentedStub("gemini");
    }
    return {
      model: parseLastModel(await readFile(input.sessionLogPath, "utf8"), [
        ["model"],
      ]),
      refusalFallback: false,
    };
  }
}

export function selectObserver(harness: string): ModelObserver {
  switch (harness.trim().toLowerCase()) {
    case "claude":
      return new ClaudeJsonlObserver();
    case "codex":
      return new CodexObserver();
    case "gemini":
      return new GeminiObserver();
    default:
      return new CmuxScreenObserver();
  }
}

function documentedStub(harness: "codex" | "gemini"): ObserverObservation {
  return {
    model: null,
    refusalFallback: false,
    note: `harness=${harness} observer is a documented stub - provide --observed-model`,
  };
}

function cleanModel(model: string | null | undefined): string | null {
  return typeof model === "string" && model.length > 0 ? model : null;
}

// Verified local session-log shapes on 2026-06-11:
// Codex: ~/.codex/sessions/**/rollout-*.jsonl and ~/.codex/archived_sessions/rollout-*.jsonl expose turn_context.payload.model.
// Gemini: ~/.gemini/tmp/**/chats/session-*.jsonl exposes a top-level model field on gemini rows.
function parseLastModel(
  jsonl: string,
  candidatePaths: readonly (readonly string[])[],
): string | null {
  let model: string | null = null;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    for (const path of candidatePaths) {
      const value = valueAt(row, path);
      if (typeof value === "string" && value.length > 0) model = value;
    }
  }
  return model;
}

function valueAt(row: unknown, path: readonly string[]): unknown {
  let value = row;
  for (const part of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

async function newestClaudeJsonl(homeDir: string): Promise<string | null> {
  const root = join(homeDir, ".claude/projects");
  const files = await listJsonl(root);
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const path of files) {
    try {
      const s = await stat(path);
      if (newest === null || s.mtimeMs > newest.mtimeMs) {
        newest = { path, mtimeMs: s.mtimeMs };
      }
    } catch {
      // Session logs can rotate while boot observes them; skip vanished files.
    }
  }
  return newest?.path ?? null;
}

async function listJsonl(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonl(path)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}
