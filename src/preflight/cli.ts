import { z } from "zod";
import { evaluate, type PreflightVerdict } from "./core";

type CliOptions = {
  requiredNames: string[];
  stdin: boolean;
  json: boolean;
  listCmd: string;
};

const cliOptionsSchema = z.object({
  requiredNames: z.array(z.string().min(1)).min(1),
  stdin: z.boolean(),
  json: z.boolean(),
  listCmd: z.string().min(1),
});

const usage = `Usage: bun run mcp-preflight --require <name[,name...]> [--stdin] [--list-cmd "<cmd>"] [--json]

Checks required MCP servers against claude mcp list output.
`;

const optionNames: Record<string, string> = {
  requiredNames: "--require",
  listCmd: "--list-cmd",
};

function parseArgs(argv: string[]): CliOptions {
  let requireValue: string | undefined;
  let stdin = false;
  let json = false;
  let listCmd = "claude mcp list";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--require") {
      requireValue = argv[++i];
    } else if (arg.startsWith("--require=")) {
      requireValue = arg.slice("--require=".length);
    } else if (arg === "--stdin") {
      stdin = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--list-cmd") {
      listCmd = argv[++i] ?? "";
    } else if (arg.startsWith("--list-cmd=")) {
      listCmd = arg.slice("--list-cmd=".length);
    } else if (arg === "--help" || arg === "-h") {
      throw new UsageRequested();
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }

  const parsed = cliOptionsSchema.safeParse({
    requiredNames: (requireValue ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    stdin,
    json,
    listCmd,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = String(issue?.path[0] ?? "arguments");
    const option = optionNames[path] ?? path;
    throw new UsageError(
      `Invalid ${option}: ${issue?.message ?? "validation failed"}`,
    );
  }

  return parsed.data;
}

class UsageError extends Error {}
class UsageRequested extends Error {}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

async function runListCommand(command: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["sh", "-lc", command],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `list command failed with exit ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`,
    );
  }

  return stdout;
}

function writeVerdict(verdict: PreflightVerdict, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(verdict));
    return;
  }

  for (const name of verdict.missing) {
    console.error(`MISSING: ${name}`);
  }
  for (const name of verdict.disconnected) {
    console.error(`DISCONNECTED: ${name}`);
  }
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageRequested) {
      console.error(usage);
      return 0;
    }

    console.error(usage);
    if (error instanceof UsageError) {
      console.error(error.message);
    }
    return 2;
  }

  try {
    const listing = options.stdin
      ? await readStdin()
      : await runListCommand(options.listCmd);
    const verdict = evaluate(options.requiredNames, listing);
    writeVerdict(verdict, options.json);
    return verdict.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
