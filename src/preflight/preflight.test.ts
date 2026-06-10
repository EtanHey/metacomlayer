import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluate, parseMcpList } from "./core";

const CLI = [join(process.cwd(), "src/preflight/cli.ts")];

async function runPreflight(args: string[], stdin = "") {
  const proc = Bun.spawn({
    cmd: ["bun", ...CLI, ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    },
  });

  proc.stdin.write(stdin);
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe("mcp preflight core", () => {
  test("evaluate marks all required connected servers ok", () => {
    const verdict = evaluate(
      ["cmux", "brainlayer"],
      "cmux: bun - ✔ Connected\nbrainlayer: socat - ✔ Connected\n",
    );

    expect(verdict).toEqual({
      ok: true,
      missing: [],
      disconnected: [],
    });
  });

  test("evaluate names required servers absent from the listing", () => {
    const verdict = evaluate(
      ["cmux", "brainlayer"],
      "cmux: bun - ✔ Connected\n",
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toEqual(["brainlayer"]);
    expect(verdict.disconnected).toEqual([]);
  });

  test("evaluate names listed required servers that are not connected", () => {
    const verdict = evaluate(["cmux"], "cmux: bun - ✗ Failed\n");

    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toEqual([]);
    expect(verdict.disconnected).toEqual(["cmux"]);
  });

  test("parser handles names with spaces and failed states", () => {
    expect(
      parseMcpList(
        "claude.ai Google Drive: https://example.test - ✔ Connected\ncmux: bun - ✗ Failed\n",
      ),
    ).toEqual(
      new Map([
        ["claude.ai Google Drive", { connected: true }],
        ["cmux", { connected: false }],
      ]),
    );
  });
});

describe("mcp-preflight CLI", () => {
  test("exits 0 when stdin fixture contains every required connected server", async () => {
    const result = await runPreflight(
      ["--require", "cmux,brainlayer", "--stdin"],
      "cmux: bun - ✔ Connected\nbrainlayer: socat - ✔ Connected\n",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("exits 1 and names missing servers on stderr", async () => {
    const result = await runPreflight(
      ["--require", "cmux,brainlayer", "--stdin"],
      "cmux: bun - ✔ Connected\n",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("MISSING: brainlayer");
  });

  test("exits 1 and names disconnected servers on stderr", async () => {
    const result = await runPreflight(
      ["--require", "cmux", "--stdin"],
      "cmux: bun - ✗ Failed\n",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("DISCONNECTED: cmux");
  });

  test("exits 2 on usage errors", async () => {
    const result = await runPreflight(["--stdin"], "");

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  test("emits machine-readable JSON verdicts", async () => {
    const result = await runPreflight(
      ["--require", "cmux,brainlayer", "--stdin", "--json"],
      "cmux: bun - ✔ Connected\n",
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      missing: ["brainlayer"],
      disconnected: [],
    });
  });

  test("uses an injected list command instead of stdin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-preflight-"));
    const fixture = join(dir, "list.txt");
    await writeFile(fixture, "cmux: bun - ✔ Connected\n", "utf8");

    const result = await runPreflight([
      "--require",
      "cmux",
      "--list-cmd",
      `cat ${fixture}`,
    ]);

    expect(result.exitCode).toBe(0);
  });
});
