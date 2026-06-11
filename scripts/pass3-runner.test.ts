import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(process.cwd(), "scripts/pass3-runner.sh");

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "pass3-runner-test-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const repo = join(root, "cmuxlayer");
  mkdirSync(join(home, ".local/share/orc"), { recursive: true, mode: 0o700 });
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# cmuxlayer\n\nhello pass3\n");
  writeFileSync(
    join(bin, "ollama"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "list" ]]; then
  printf 'NAME ID SIZE MODIFIED\\n'
  printf 'tiny-model:latest abc 1GB now\\n'
  exit 0
fi
if [[ "\${1:-}" == "run" ]]; then
  cat >/dev/null
  printf '{"graph":"ok"}\\n'
  exit 0
fi
exit 2
`,
  );
  writeFileSync(
    join(bin, "memory_pressure"),
    `#!/usr/bin/env bash
printf 'System-wide memory free percentage: %s%%\\n' "\${FAKE_FREE_PCT:-88}"
`,
  );
  chmodSync(join(bin, "ollama"), 0o755);
  chmodSync(join(bin, "memory_pressure"), 0o755);
  return { root, home, bin, repo };
}

function run(args: string[], fixture: ReturnType<typeof makeFixture>, env = {}) {
  return Bun.spawnSync(["bash", SCRIPT, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      ...env,
    },
  });
}

function stdout(proc: ReturnType<typeof Bun.spawnSync>) {
  return new TextDecoder().decode(proc.stdout);
}

function stderr(proc: ReturnType<typeof Bun.spawnSync>) {
  return new TextDecoder().decode(proc.stderr);
}

function journalRows(home: string) {
  const db = new Database(join(home, ".local/share/orc/fleet-journal.db"), {
    readonly: true,
  });
  try {
    return db
      .query("select topic, type, payload_json from events order by seq")
      .all() as Array<{ topic: string; type: string; payload_json: string }>;
  } finally {
    db.close();
  }
}

describe("pass3-runner", () => {
  test("dry-run stamps one batch, checkpoints it, then resumes by skipping it", () => {
    const fixture = makeFixture();
    try {
      const args = [
        "--dry-run",
        "--repo",
        `cmuxlayer=${fixture.repo}`,
        "--checkpoint",
        join(fixture.home, ".local/share/orc/pass3-checkpoint.json"),
      ];
      const first = run(args, fixture);
      expect(first.exitCode).toBe(0);
      expect(stdout(first)).toContain("PASS3_DRY_RUN_DONE: completed exactly one batch");
      expect(stdout(first)).toContain("local.perf");
      expect(stderr(first)).toContain("PASS3_MODEL_FALLBACK");

      const checkpoint = JSON.parse(
        readFileSync(join(fixture.home, ".local/share/orc/pass3-checkpoint.json"), "utf8"),
      );
      expect(checkpoint.completed).toHaveLength(1);
      expect(checkpoint.completed[0]).toMatchObject({
        repo: "cmuxlayer",
        batch: 1,
        model: "tiny-model:latest",
      });

      const perf = journalRows(fixture.home).filter((row) => row.type === "local.perf");
      expect(perf).toHaveLength(1);
      expect(JSON.parse(perf[0]!.payload_json)).toMatchObject({
        op: "pass3-graphify",
        model: "tiny-model:latest",
        chunk_batch: "cmuxlayer:1",
      });

      const second = run(args, fixture);
      expect(second.exitCode).toBe(0);
      expect(stdout(second)).toContain("checkpoint already contains cmuxlayer:1");
      expect(stdout(second)).toContain("resume skip proven");
      expect(journalRows(fixture.home).filter((row) => row.type === "local.perf")).toHaveLength(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("low-memory path journals pass3.aborted and exits non-zero before Ollama", () => {
    const fixture = makeFixture();
    try {
      const result = run(
        [
          "--dry-run",
          "--repo",
          `cmuxlayer=${fixture.repo}`,
          "--memory-threshold",
          "100",
        ],
        fixture,
        { FAKE_FREE_PCT: "88" },
      );
      expect(result.exitCode).toBe(75);
      expect(stderr(result)).toContain("PASS3_ABORTED");

      const aborted = journalRows(fixture.home).find((row) => row.type === "pass3.aborted");
      expect(aborted?.topic).toBe("perf");
      expect(JSON.parse(aborted!.payload_json)).toMatchObject({
        op: "pass3-graphify",
        repo: "cmuxlayer",
        batch: "1",
        threshold: "100",
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
