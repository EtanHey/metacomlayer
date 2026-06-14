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

function argValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const source = argValue(Bun.argv.slice(2), "--source") ??
    `${process.env.HOME}/.local/state/cmux-agents/events.jsonl`;
  const cursorFile = markerPath("cmux-agents-events.cursor");
  const lines = await readJsonLines(source);
  const sourceLineCount = lines.length;
  const cursor = await loadCursor(cursorFile);
  const startLine = cursor?.source === source ? cursor.next_line : 1;
  let imported = 0;

  for (let lineNo = startLine; lineNo <= sourceLineCount; lineNo++) {
    const row = parseLine(lines[lineNo - 1]!);
    const payload = withCmuxProvenance(row, {
      backfilled: true,
      line: lineNo,
      sourceLineCount,
    });
    await clxAppend(CMUX_TOPIC, eventType(row, "cmux.event"), payload);
    imported++;
  }

  await saveCursor(cursorFile, {
    source,
    next_line: sourceLineCount + 1,
    source_line_count: sourceLineCount,
    updated_at: new Date().toISOString(),
  });

  console.log(JSON.stringify({ ok: true, sourceLineCount, imported }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
