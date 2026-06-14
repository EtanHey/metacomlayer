import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const movedPaths = [
  "src/clx",
  "src/boot",
  "src/preflight",
  "src/perf",
  "scripts/clx-guard",
];

const removedScripts = ["clx", "clx-boot", "mcp-preflight", "stamp-perf"];

describe("metacomlayer boundary", () => {
  test("does not contain control-layer source trees", () => {
    const present = movedPaths.filter((path) => existsSync(path));

    expect(present).toEqual([]);
  });

  test("package scripts expose only MCL commands", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    const present = removedScripts.filter((script) => pkg.scripts?.[script]);

    expect(present).toEqual([]);
  });
});
