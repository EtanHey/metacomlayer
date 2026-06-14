import {
  SIGNAL_TOPIC,
  clxAppend,
  fitPayload,
  parseLine,
  readJsonLines,
  readStdin,
} from "./clx-auto-index-core";

type Signal = {
  signalClass: "SIGTTIN" | "TTY_SUSPEND" | "WORKSPACE_NOT_FOUND";
  type: "signal.sigttin" | "signal.tty-suspend" | "signal.workspace-not-found";
};

function argValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function classify(row: Record<string, unknown>): Signal | null {
  const haystack = JSON.stringify(row);
  if (haystack.includes("SIGTTIN")) {
    return { signalClass: "SIGTTIN", type: "signal.sigttin" };
  }
  if (haystack.includes("zsh: suspended (tty input)")) {
    return { signalClass: "TTY_SUSPEND", type: "signal.tty-suspend" };
  }
  if (/Workspace-not-found|workspace not found/i.test(haystack)) {
    return {
      signalClass: "WORKSPACE_NOT_FOUND",
      type: "signal.workspace-not-found",
    };
  }
  return null;
}

async function inputRows() {
  const fixture = argValue(Bun.argv.slice(2), "--fixture");
  const lines = fixture ? await readJsonLines(fixture) : (await readStdin()).split("\n");
  return lines.filter(Boolean).map((line) => parseLine(line));
}

async function main() {
  let captured = 0;
  for (const row of await inputRows()) {
    const signal = classify(row);
    if (!signal) continue;
    await clxAppend(
      SIGNAL_TOPIC,
      signal.type,
      fitPayload({
        ...row,
        root_cause_shape: "wf4-F30",
        signal_class: signal.signalClass,
        source_artifact: "signal-capture",
        backfilled: false,
      }),
    );
    captured++;
  }
  console.log(JSON.stringify({ ok: true, captured }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
