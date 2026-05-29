#!/usr/bin/env bun
/**
 * Live end-to-end round-trip against the REAL mcplayer daemon.
 *
 * Proves connect/publish/subscribe/ack/status over the actual UDS socket — the
 * "real execution" acceptance for the MockMcplayer→RealMcplayer swap. Runnable
 * the instant mcplayer ships its durable-queue server (D2):
 *
 *   MCPLAYER_SOCKET=/path/to/mcplayer.sock bun scripts/live-roundtrip.ts
 *
 * Until D2 lands, this exits non-zero with a clear diagnostic (the default
 * /tmp/mcplayer.sock currently speaks the broker's Content-Length/LSP proxy
 * framing, NOT the NDJSON durable-queue surface) — that diagnostic IS the
 * evidence behind the BLOCKED line in the gen-10 collab.
 */
import { RealMcplayer } from "../src/client/real-mcplayer";

const sock = process.env.MCPLAYER_SOCKET ?? "/tmp/mcplayer.sock";
const CH = "channel:live-roundtrip";

function log(step: string, v: unknown) {
  console.log(`  ✓ ${step}:`, JSON.stringify(v));
}

const deadline = setTimeout(() => {
  console.error("✗ TIMEOUT — no NDJSON JSON-RPC response within 4s.");
  console.error(
    "  Likely the durable-queue server (D2) is not listening on",
    sock,
  );
  process.exit(2);
}, 4000);

try {
  console.log(`live-roundtrip → ${sock}`);
  const mp = await RealMcplayer.open({ socketPath: sock });

  log("connect", await mp.connect({ client_id: "mcl-live-roundtrip" }));
  log("status", await mp.status());

  const message_id = `lrt-${process.pid}`;
  log(
    "publish",
    await mp.publish({
      channel: CH,
      message_id,
      payload: { hello: "mcl" },
      durable: true,
    }),
  );

  const got: unknown[] = [];
  await mp.subscribe({ channel: CH, from_offset: 0 }, (m) => got.push(m));
  await new Promise((r) => setTimeout(r, 500));
  log("subscribe received", got);

  log("ack", await mp.ack({ channel: CH, message_id }));

  clearTimeout(deadline);
  if (got.length === 0) {
    console.error(
      "✗ published message did not arrive on subscribe — server not durable-queue-conformant",
    );
    process.exit(3);
  }
  console.log(
    "✅ LIVE ROUND-TRIP PASSED — connect/publish/subscribe/ack/status all conformant.",
  );
  mp.close();
  process.exit(0);
} catch (e) {
  clearTimeout(deadline);
  console.error("✗ FAILED:", e instanceof Error ? e.message : String(e));
  console.error(
    "  (Expected until mcplayer D2 durable-queue server is live on the NDJSON surface.)",
  );
  process.exit(1);
}
