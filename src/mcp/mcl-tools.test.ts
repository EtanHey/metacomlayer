import { describe, test, expect } from "bun:test";
import { MockMcplayer } from "../client/mock-mcplayer";
import { MclClient } from "../client/client";
import { createMclToolset } from "./mcl-tools";

/**
 * Receipts must route to the SENDER's PRIVATE ack channel (via reply_to), not a
 * shared global channel — otherwise, on a competing-consumer bus, another
 * consumer on the shared channel steals the receipt and the sender never reaches
 * VERIFIED (the real failure the live 2-agent demo hit). publish exposes its
 * receipt_channel; ack delivers the receipt there.
 */
describe("mcl-tools — private reply_to receipt routing", () => {
  test("publish returns its private receipt_channel (channel:ack:<sender>)", async () => {
    const mp = new MockMcplayer();
    const a = new MclClient(mp, "agent-a");
    await a.connect();
    const ta = createMclToolset(a, "agent-a");
    const pub = await ta.publish({
      channel: "channel:demo",
      subject: "s",
      body: "hi",
      requires_ack: true,
    });
    expect(pub.receipt_channel).toBe("channel:ack:agent-a");
  });

  test("an ack delivers the SHIP-3 receipt to the sender's reply_to, where the sender finds it", async () => {
    const mp = new MockMcplayer();
    const a = new MclClient(mp, "agent-a");
    const b = new MclClient(mp, "agent-b");
    await a.connect();
    await b.connect();
    const ta = createMclToolset(a, "agent-a");
    const tb = createMclToolset(b, "agent-b");

    const pub = await ta.publish({
      channel: "channel:demo",
      subject: "Reschedule",
      body: "Sun→Wed",
      requires_ack: true,
    });
    const got = await tb.poll({ channel: "channel:demo", wait_ms: 1000 });
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]!.reply_to).toBe("channel:ack:agent-a"); // receiver sees where to reply

    const ackRes = await tb.ack({
      channel: "channel:demo",
      message_id: got.messages[0]!.message_id,
    });
    expect(ackRes.receipt_sent).toBe(true);

    // sender polls its PRIVATE receipt channel and finds the receipt for its correlation_id
    const receipts = await ta.poll({
      channel: pub.receipt_channel!,
      wait_ms: 1000,
    });
    expect(receipts.messages.some((m) => m.body === pub.correlation_id)).toBe(
      true,
    );
  });
});

describe("mcl-tools — robustness (no meta leak, no subscription poisoning)", () => {
  test("acking the same message twice is idempotent — the second ack sends no receipt", async () => {
    const mp = new MockMcplayer();
    const a = new MclClient(mp, "agent-a");
    const b = new MclClient(mp, "agent-b");
    await a.connect();
    await b.connect();
    const ta = createMclToolset(a, "agent-a");
    const tb = createMclToolset(b, "agent-b");

    await ta.publish({
      channel: "channel:demo",
      subject: "s",
      body: "hi",
      requires_ack: true,
    });
    const got = await tb.poll({ channel: "channel:demo", wait_ms: 1000 });
    const mid = got.messages[0]!.message_id;

    const first = await tb.ack({ channel: "channel:demo", message_id: mid });
    const second = await tb.ack({ channel: "channel:demo", message_id: mid });
    expect(first.receipt_sent).toBe(true);
    // meta entry purged after the first ack → no duplicate receipt, no leak
    expect(second.receipt_sent).toBe(false);
  });

  test("a failed subscribe does not poison the channel — a later poll retries and receives", async () => {
    const mp = new MockMcplayer();
    const a = new MclClient(mp, "agent-a");
    const b = new MclClient(mp, "agent-b");
    await a.connect();
    await b.connect();
    const ta = createMclToolset(a, "agent-a");

    // make agent-b's FIRST receive throw, then behave normally
    const realReceive = b.receive.bind(b);
    let calls = 0;
    (b as unknown as { receive: typeof b.receive }).receive = ((
      ch: string,
      h: Parameters<typeof b.receive>[1],
      fo?: number,
    ) => {
      calls++;
      if (calls === 1) throw new Error("transient subscribe failure");
      return realReceive(ch, h, fo);
    }) as typeof b.receive;
    const tb = createMclToolset(b, "agent-b");

    // first poll: subscribe throws → poll rejects
    await expect(
      tb.poll({ channel: "channel:flap", wait_ms: 50 }),
    ).rejects.toThrow();

    // a message lands while b is "unsubscribed"
    await ta.publish({
      channel: "channel:flap",
      subject: "s",
      body: "after-fail",
    });

    // fixed: the next poll RE-subscribes (replays from 0) and receives it.
    // poisoned: channel stuck "subscribed" with no subscription → never arrives.
    const got = await tb.poll({ channel: "channel:flap", wait_ms: 1000 });
    expect(got.messages.map((m) => m.body)).toContain("after-fail");
  });
});
