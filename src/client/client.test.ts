import { describe, test, expect } from "bun:test";
import { MockMcplayer } from "./mock-mcplayer";
import { MclClient, Backpressure, type ReceivedMessage } from "./client";
import { buildMessage } from "../schema/envelope";

const OWNERS = "channel:owners";
const SHIP3_FACT = "I'm presenting Wednesday not Sunday";

function headsUp(recipient: string) {
  return buildMessage({
    method: "mcl.headsup",
    sender: { id: "orc", role: "orchestrator" },
    recipient,
    thread_id: "ship3",
    subject: "fact-propagation",
    body: SHIP3_FACT,
    requires_ack: true,
  });
}

describe("mcl-client over mock mcplayer — async-while-offline", () => {
  test("a message published while the consumer is OFFLINE is received on subscribe+drain", async () => {
    const mp = new MockMcplayer();
    const sender = new MclClient(mp, "orc");
    await sender.connect();

    // receiver is NOT subscribed yet (offline at send time) — the whole point.
    const msg = headsUp(OWNERS);
    await sender.send(msg);

    // now the receiver comes up and drains its inbox
    const received: ReceivedMessage[] = [];
    const receiver = new MclClient(mp, "brainlayerClaude");
    await receiver.connect();
    await receiver.receive(OWNERS, (m) => void received.push(m), 0);

    expect(received).toHaveLength(1);
    expect(received[0]!.envelope.params.payload.body).toBe(SHIP3_FACT);
    expect(received[0]!.envelope).toEqual(msg); // exact round-trip through transport
    expect(MclClient.requiresReceipt(received[0]!.envelope)).toBe(true);
  });

  test("ack frees WAL capacity; acked messages are not replayed", async () => {
    const mp = new MockMcplayer({ capacityPerChannel: 2 });
    const c = new MclClient(mp, "orc");
    await c.connect();

    const m1 = headsUp(OWNERS);
    await c.send(m1);
    await c.ack(OWNERS, m1.params.routing.message_id);

    // a fresh subscriber should NOT see the acked message
    const seen: ReceivedMessage[] = [];
    await c.receive(OWNERS, (m) => void seen.push(m), 0);
    expect(seen).toHaveLength(0);
  });

  test("BUSY nack (A2): a full bounded WAL surfaces Backpressure, never a silent drop", async () => {
    const mp = new MockMcplayer({ capacityPerChannel: 1 });
    const c = new MclClient(mp, "orc");
    await c.connect();

    await c.send(headsUp(OWNERS)); // fills the 1-slot WAL (unacked)
    await expect(c.send(headsUp(OWNERS))).rejects.toBeInstanceOf(Backpressure);
  });

  test("monotonic offsets + resume across an mcplayer RESTART (A2)", async () => {
    const mp = new MockMcplayer();
    const sender = new MclClient(mp, "orc");
    await sender.connect();
    await sender.send(headsUp(OWNERS));
    await sender.send(headsUp(OWNERS));

    // mcplayer restarts; durable WAL survives via snapshot
    const mp2 = new MockMcplayer({ snapshot: mp.snapshot() });
    const receiver = new MclClient(mp2, "late");
    await receiver.connect();
    const seen: ReceivedMessage[] = [];
    await receiver.receive(OWNERS, (m) => void seen.push(m), 0);

    expect(seen).toHaveLength(2);
    expect(seen[0]!.raw.offset).toBe(0);
    expect(seen[1]!.raw.offset).toBe(1); // monotonic, preserved across restart
  });
});

describe("two-plane stability (A1) — connection plane independent of queue plane", () => {
  test("status() answers WHILE the engine is down", async () => {
    const mp = new MockMcplayer({ engineState: "not-up" });
    const c = new MclClient(mp, "orc");
    await c.connect(); // never blocks on engine availability
    expect((await mp.status()).state).toBe("not-up");
  });

  test("a faulted queue plane does NOT break connect()/status()", async () => {
    const mp = new MockMcplayer();
    mp.queueFaulted = true; // queue subsystem is broken
    const c = new MclClient(mp, "orc");
    await c.connect(); // still works
    expect((await mp.status()).state).toBe("up"); // still answerable
    // but the queue plane itself fails loudly (never silent)
    await expect(c.send(headsUp(OWNERS))).rejects.toBeTruthy();
  });
});
