import { STALKER_TOPIC, clxAppend, fitPayload, readStdin } from "./clx-auto-index-core";

function argValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = Bun.argv.slice(2);
  const type = argValue(args, "--type") ?? "capture";
  const text = (await readStdin()).trim();
  const row = text ? JSON.parse(text) as Record<string, unknown> : {};
  await clxAppend(
    STALKER_TOPIC,
    `stalker.${type}`,
    fitPayload({
      ...row,
      backfilled: false,
      source_artifact: "stalker",
    }),
  );
  console.log(JSON.stringify({ ok: true, appended: 1 }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
