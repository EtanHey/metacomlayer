export type McpServerStatus = {
  connected: boolean;
};

export type PreflightVerdict = {
  ok: boolean;
  missing: string[];
  disconnected: string[];
};

const connectedPattern = /-\s*✔\s*Connected\s*$/u;
const disconnectedPattern = /-\s*(?:✗|x)\s*(?:Failed|Disconnected)?\s*$/iu;

export function parseMcpList(listing: string): Map<string, McpServerStatus> {
  const servers = new Map<string, McpServerStatus>();

  for (const rawLine of listing.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const separator = line.indexOf(":");
    if (separator <= 0) continue;

    const name = line.slice(0, separator).trim();
    const details = line.slice(separator + 1).trim();
    if (name.length === 0) continue;

    servers.set(name, {
      connected:
        connectedPattern.test(details) && !disconnectedPattern.test(details),
    });
  }

  return servers;
}

export function evaluate(
  requiredNames: string[],
  listing: string,
): PreflightVerdict {
  const servers = parseMcpList(listing);
  const missing: string[] = [];
  const disconnected: string[] = [];

  for (const requiredName of requiredNames) {
    const name = requiredName.trim();
    if (name.length === 0) continue;

    const status = servers.get(name);
    if (!status) {
      missing.push(name);
    } else if (!status.connected) {
      disconnected.push(name);
    }
  }

  return {
    ok: missing.length === 0 && disconnected.length === 0,
    missing,
    disconnected,
  };
}
