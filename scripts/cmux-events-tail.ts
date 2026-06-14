import {
  CMUX_TOPIC,
  clxAppend,
  eventType,
  loadCursor,
  markerPath,
  parseLine,
  readJsonLines,
  saveCursor,
  withCmuxProvenance,
} from "./clx-auto-index-core";

function hasArg(args: string[], name: string) {
  return args.includes(name);
}

function argValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function appendNew(source: string) {
  const cursorFile = markerPath("cmux-agents-events-live.cursor");
  const lines = await readJsonLines(source);
  const sourceLineCount = lines.length;
  const cursor = await loadCursor(cursorFile);
  const startLine = cursor?.source === source ? cursor.next_line : 1;
  let appended = 0;

  for (let lineNo = startLine; lineNo <= sourceLineCount; lineNo++) {
    const row = parseLine(lines[lineNo - 1]!);
    await clxAppend(
      CMUX_TOPIC,
      eventType(row, "cmux.event"),
      withCmuxProvenance(row, {
        backfilled: false,
        line: lineNo,
        sourceLineCount,
      }),
    );
    appended++;
  }

  await saveCursor(cursorFile, {
    source,
    next_line: sourceLineCount + 1,
    source_line_count: sourceLineCount,
    updated_at: new Date().toISOString(),
  });
  return { sourceLineCount, appended };
}

async function main() {
  const args = Bun.argv.slice(2);
  const source = argValue(args, "--source") ??
    `${process.env.HOME}/.local/state/cmux-agents/events.jsonl`;

  if (hasArg(args, "--once")) {
    console.log(JSON.stringify({ ok: true, ...(await appendNew(source)) }));
    return;
  }

  for (;;) {
    await appendNew(source);
    await Bun.sleep(1000);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
