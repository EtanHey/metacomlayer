#!/usr/bin/env bun
/**
 * a2a-bus.ts — a self-contained mcplayer-protocol bus for the A2A DEMO.
 *
 * Binds MCPLAYER_SOCKET (default /tmp/mcplayer-bus.sock) and speaks the exact
 * mcplayer PROTOCOL.md v0 NDJSON/JSON-RPC 2.0 surface (connect/publish/subscribe
 * /ack/status) with an in-memory durable queue (monotonic offsets, replay,
 * cross-connection push). It exists so the demo runs from ONE repo with zero
 * external dependency.
 *
 * PREFERRED for production/recording: the real mcplayer D2 server on the same
 * socket (EtanHey/mcplayer PR #20). This bundled bus is the drop-in stand-in
 * while D2 isn't running persistently — RealMcplayer can't tell them apart.
 *
 *   MCPLAYER_SOCKET=/tmp/mcplayer-bus.sock bun scripts/a2a-bus.ts
 */
const SOCK = process.env.MCPLAYER_SOCKET ?? "/tmp/mcplayer-bus.sock";

interface Stored {
  message_id: string;
  payload: unknown;
  offset: number;
  acked: boolean;
}
interface Chan {
  next: number;
  msgs: Stored[];
}
const channels = new Map<string, Chan>();
const bufs = new WeakMap<object, string>();
const subs = new Map<string, Set<{ write: (s: string) => void }>>();

const chan = (n: string): Chan => {
  let c = channels.get(n);
  if (!c) {
    c = { next: 0, msgs: [] };
    channels.set(n, c);
  }
  return c;
};
const send = (s: { write: (x: string) => void }, o: unknown) =>
  s.write(JSON.stringify(o) + "\n");
const stamp = () => new Date().toISOString().slice(11, 19);

function handle(sock: { write: (s: string) => void }, line: string) {
  let req: { id?: string | number; method: string; params: any };
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const ok = (result: unknown) =>
    send(sock, { jsonrpc: "2.0", id: req.id, result });
  const err = (code: number, message: string) =>
    send(sock, { jsonrpc: "2.0", id: req.id, error: { code, message } });
  switch (req.method) {
    case "mcplayer.connect":
      console.log(`[${stamp()}] connect ${req.params.client_id}`);
      return ok({ session_id: `sess:${req.params.client_id}` });
    case "mcplayer.status":
      return ok({ state: "up", since: new Date().toISOString() });
    case "mcplayer.publish": {
      const c = chan(req.params.channel);
      const dup = c.msgs.find((m) => m.message_id === req.params.message_id);
      if (dup) return ok({ enqueued: true, offset: dup.offset });
      const offset = c.next++;
      c.msgs.push({
        message_id: req.params.message_id,
        payload: req.params.payload,
        offset,
        acked: false,
      });
      console.log(
        `[${stamp()}] publish → ${req.params.channel} #${offset} (${req.params.message_id})`,
      );
      ok({ enqueued: true, offset });
      for (const s of subs.get(req.params.channel) ?? [])
        send(s, {
          jsonrpc: "2.0",
          method: "mcplayer.message",
          params: {
            channel: req.params.channel,
            message_id: req.params.message_id,
            payload: req.params.payload,
            offset,
          },
        });
      return;
    }
    case "mcplayer.subscribe": {
      const c = chan(req.params.channel);
      ok({ subscribed: true });
      const from = req.params.from_offset ?? 0;
      console.log(
        `[${stamp()}] subscribe ${req.params.channel} from_offset=${from}`,
      );
      for (const m of c.msgs
        .filter((m) => m.offset >= from && !m.acked)
        .sort((a, b) => a.offset - b.offset))
        send(sock, {
          jsonrpc: "2.0",
          method: "mcplayer.message",
          params: {
            channel: req.params.channel,
            message_id: m.message_id,
            payload: m.payload,
            offset: m.offset,
          },
        });
      const set = subs.get(req.params.channel) ?? new Set();
      set.add(sock);
      subs.set(req.params.channel, set);
      return;
    }
    case "mcplayer.ack": {
      const c = channels.get(req.params.channel);
      const m = c?.msgs.find((x) => x.message_id === req.params.message_id);
      if (m) m.acked = true;
      console.log(
        `[${stamp()}] ack ${req.params.channel} (${req.params.message_id})`,
      );
      return ok({ acked: true });
    }
    default:
      return err(-32601, `method not found: ${req.method}`);
  }
}

Bun.listen({
  unix: SOCK,
  socket: {
    open() {
      /* connection opened */
    },
    data(sock: object, data: Uint8Array) {
      let b = (bufs.get(sock) ?? "") + Buffer.from(data).toString("utf8");
      let nl: number;
      while ((nl = b.indexOf("\n")) >= 0) {
        const line = b.slice(0, nl).trim();
        b = b.slice(nl + 1);
        if (line)
          handle(sock as unknown as { write: (s: string) => void }, line);
      }
      bufs.set(sock, b);
    },
    close(sock: object) {
      for (const set of subs.values())
        set.delete(sock as unknown as { write: (s: string) => void });
    },
  },
});
console.log(
  `MCPLAYER_BUS_LISTENING socket=${SOCK} (bundled demo bus — protocol-compatible with mcplayer D2)`,
);
