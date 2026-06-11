import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ClaudeJsonlObserver,
  CmuxScreenObserver,
  CodexObserver,
  GeminiObserver,
  selectObserver,
} from "./observers";

async function tempJsonl(lines: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "clx-observer-"));
  const path = join(dir, "session.jsonl");
  await writeFile(
    path,
    lines
      .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
      .join("\n"),
  );
  return path;
}

describe("clx boot observer adapters", () => {
  test("ClaudeJsonlObserver wraps core observeModel for last model and refusal fallback", async () => {
    const jsonlPath = await tempJsonl([
      { type: "assistant", message: { model: "claude-fable-5" } },
      { type: "system", subtype: "model_refusal_fallback" },
      { type: "assistant", message: { model: "claude-opus-4-8[1m]" } },
    ]);

    const observed = await new ClaudeJsonlObserver().observe({ jsonlPath });

    expect(observed).toEqual({
      model: "claude-opus-4-8[1m]",
      refusalFallback: true,
    });
  });

  test("CmuxScreenObserver returns the passed parsed model without inventing one", async () => {
    await expect(
      new CmuxScreenObserver().observe({ observedModel: "gpt-5.5" }),
    ).resolves.toEqual({ model: "gpt-5.5", refusalFallback: false });

    await expect(new CmuxScreenObserver().observe({})).resolves.toEqual({
      model: null,
      refusalFallback: false,
    });

    await expect(
      new CmuxScreenObserver().observe({ observedModel: "" }),
    ).resolves.toEqual({
      model: null,
      refusalFallback: false,
    });
  });

  test("CodexObserver parses a documented session log path and stubs honestly without one", async () => {
    const sessionLogPath = await tempJsonl([
      {
        type: "turn_context",
        payload: { model: "gpt-5.5" },
      },
    ]);

    await expect(new CodexObserver().observe({ sessionLogPath })).resolves.toEqual({
      model: "gpt-5.5",
      refusalFallback: false,
    });

    await expect(new CodexObserver().observe({})).resolves.toEqual({
      model: null,
      refusalFallback: false,
      note: "harness=codex observer is a documented stub - provide --observed-model",
    });
  });

  test("GeminiObserver parses a documented session log path and stubs honestly without one", async () => {
    const sessionLogPath = await tempJsonl([
      {
        type: "gemini",
        model: "gemini-3-flash-preview",
      },
    ]);

    await expect(
      new GeminiObserver().observe({ sessionLogPath }),
    ).resolves.toEqual({
      model: "gemini-3-flash-preview",
      refusalFallback: false,
    });

    await expect(new GeminiObserver().observe({})).resolves.toEqual({
      model: null,
      refusalFallback: false,
      note: "harness=gemini observer is a documented stub - provide --observed-model",
    });
  });

  test("selectObserver dispatches known harnesses and falls back to cmux", () => {
    expect(selectObserver("claude")).toBeInstanceOf(ClaudeJsonlObserver);
    expect(selectObserver("Claude")).toBeInstanceOf(ClaudeJsonlObserver);
    expect(selectObserver("CLAUDE")).toBeInstanceOf(ClaudeJsonlObserver);
    expect(selectObserver("codex")).toBeInstanceOf(CodexObserver);
    expect(selectObserver("CoDeX")).toBeInstanceOf(CodexObserver);
    expect(selectObserver("gemini")).toBeInstanceOf(GeminiObserver);
    expect(selectObserver("GEMINI")).toBeInstanceOf(GeminiObserver);
    expect(selectObserver("unknown")).toBeInstanceOf(CmuxScreenObserver);
    expect(selectObserver("UNKNOWN")).toBeInstanceOf(CmuxScreenObserver);
  });
});
