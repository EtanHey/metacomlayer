import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { RealMcplayer } from "./real-mcplayer";
import { McplayerError } from "./mcplayer-interface";
import { MclClient } from "./client";
import { buildMessage } from "../schema/envelope";

/**
 * Conformance test for RealMcplayer over a REAL Unix Domain Socket. A faithful
 * in-test NDJSON/JSON-RPC server implements the mcplayer PROTOCOL.md v0 surface,
 * so this exercises the actual client wire behavior (framing, id-matching,
 * notification routing, -32004 nack) — not the in-process MockMcplayer. The live
 * daemon end-to-end round-trip is gated separately (see scripts/live-roundtrip.ts)
 * and is BLOCKED until mcplayer ships the durable-queue server (D2).
 */

const SOCK = `/tmp/mcl-conformance-${process.pid}.sock`;

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

let server: { stop: () => void };
const channels = new Map<string, Chan>();
let capacity = 1024;
const bufs = new WeakMap<object, string>();
// channel -> set of subscriber sockets (with their from_offset already drained)
const subscribers = new Map<string, Set<{ write: (s: string) => void }>>();

function chan(name: string): Chan {
  let c = channels.get(name);
  if (!c) {
    c = { next: 0, msgs: [] };
    channels.set(name, c);
  }
  return c;
}
function send(sock: { write: (s: string) => void }, obj: unknown) {
  sock.write(JSON.stringify(obj) + "\n");
}

function handle(sock: { write: (s: string) => void }, line: string) {
  const req = JSON.parse(line) as {
    id?: string | number;
    method: string;
    params: any;
  };
  const reply = (result: unknown) =>
    send(sock, { jsonrpc: "2.0", id: req.id, result });
  const err = (code: number, message: string) =>
    send(sock, { jsonrpc: "2.0", id: req.id, error: { code, message } });
  switch (req.method) {
    case "mcplayer.connect":
      return reply({ session_id: `sess:${req.params.client_id}` });
    case "mcplayer.status":
      return reply({ state: "up", since: "2026-05-29T00:00:00Z" });
    case "mcplayer.publish": {
      const c = chan(req.params.channel);
      const existing = c.msgs.find(
        (m) => m.message_id === req.params.message_id,
      );
      if (existing) return reply({ enqueued: true, offset: existing.offset });
      if (c.msgs.filter((m) => !m.acked).length >= capacity)
        return err(-32004, "WAL full (BUSY)");
      const offset = c.next++;
      c.msgs.push({
        message_id: req.params.message_id,
        payload: req.params.payload,
        offset,
        acked: false,
      });
      reply({ enqueued: true, offset });
      for (const s of subscribers.get(req.params.channel) ?? [])
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
      reply({ subscribed: true });
      const from = req.params.from_offset ?? 0;
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
      const set = subscribers.get(req.params.channel) ?? new Set();
      set.add(sock);
      subscribers.set(req.params.channel, set);
      return;
    }
    case "mcplayer.ack": {
      const c = channels.get(req.params.channel);
      const m = c?.msgs.find((x) => x.message_id === req.params.message_id);
      if (m) m.acked = true;
      return reply({ acked: true });
    }
    default:
      return err(-32601, `method not found: ${req.method}`);
  }
}

beforeAll(() => {
  server = Bun.listen({
    unix: SOCK,
    socket: {
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
    },
  });
});

afterAll(() => server?.stop());

function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error("timeout"));
      }
    }, 5);
  });
}

describe("RealMcplayer — conformance over a real UDS socket", () => {
  test("connect / status round-trip", async () => {
    const mp = await RealMcplayer.open({ socketPath: SOCK });
    expect((await mp.connect({ client_id: "orc" })).session_id).toBe(
      "sess:orc",
    );
    expect((await mp.status()).state).toBe("up");
    mp.close();
  });

  test("publish returns monotonic offsets; idempotent on message_id", async () => {
    const mp = await RealMcplayer.open({ socketPath: SOCK });
    const a = await mp.publish({
      channel: "channel:p",
      message_id: "m1",
      payload: { n: 1 },
    });
    const b = await mp.publish({
      channel: "channel:p",
      message_id: "m2",
      payload: { n: 2 },
    });
    expect(a.offset).toBe(0);
    expect(b.offset).toBe(1);
    const dup = await mp.publish({
      channel: "channel:p",
      message_id: "m1",
      payload: { n: 1 },
    });
    expect(dup.offset).toBe(0); // idempotent
    mp.close();
  });

  test("subscribe replays backlog as mcplayer.message notifications, in order", async () => {
    const mp = await RealMcplayer.open({ socketPath: SOCK });
    await mp.publish({
      channel: "channel:s",
      message_id: "s1",
      payload: "first",
    });
    await mp.publish({
      channel: "channel:s",
      message_id: "s2",
      payload: "second",
    });
    const got: Array<{ offset: number; payload: unknown }> = [];
    await mp.subscribe({ channel: "channel:s", from_offset: 0 }, (m) => {
      got.push({ offset: m.offset, payload: m.payload });
    });
    await waitFor(() => got.length >= 2);
    expect(got.map((g) => g.offset)).toEqual([0, 1]);
    expect(got.map((g) => g.payload)).toEqual(["first", "second"]);
    mp.close();
  });

  test("a -32004 BUSY nack surfaces as McplayerError", async () => {
    capacity = 1;
    const mp = await RealMcplayer.open({ socketPath: SOCK });
    await mp.publish({ channel: "channel:busy", message_id: "b1", payload: 1 });
    await expect(
      mp.publish({ channel: "channel:busy", message_id: "b2", payload: 2 }),
    ).rejects.toBeInstanceOf(McplayerError);
    capacity = 1024;
    mp.close();
  });

  test("ZERO-MCL-CHANGE: MclClient works over RealMcplayer exactly as over the mock", async () => {
    const mp = await RealMcplayer.open({ socketPath: SOCK });
    const orc = new MclClient(mp, "orc");
    await orc.connect();
    const msg = buildMessage({
      method: "mcl.headsup",
      sender: { id: "orc", role: "orchestrator" },
      recipient: "channel:owners",
      thread_id: "ship3",
      subject: "fact",
      body: "I'm presenting Wednesday not Sunday",
      requires_ack: true,
    });
    await orc.send(msg);

    const seen: string[] = [];
    const receiver = new MclClient(mp, "brainlayer");
    await receiver.receive("channel:owners", ({ envelope }) => {
      seen.push(envelope.params.payload.body);
    });
    await waitFor(() => seen.length >= 1);
    expect(seen[0]).toBe("I'm presenting Wednesday not Sunday"); // schema-validated through the real socket
    mp.close();
  });
});
