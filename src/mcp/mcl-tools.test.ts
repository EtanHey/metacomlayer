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
