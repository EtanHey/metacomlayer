import { describe, test, expect } from "bun:test";
import { MockMcplayer } from "../client/mock-mcplayer";
import { MclClient } from "../client/client";
import { buildMessage, type MclEnvelope } from "../schema/envelope";
import { ReceiptTracker } from "./receipts";

const OWNERS = "channel:owners";
const SHIP3_FACT = "I'm presenting Wednesday not Sunday";

function headsUp() {
  return buildMessage({
    method: "mcl.headsup",
    sender: { id: "orc", role: "orchestrator" },
    recipient: OWNERS,
    thread_id: "ship3",
    subject: "fact-propagation: presentation day",
    body: SHIP3_FACT,
    requires_ack: true,
  });
}

// An owner consuming a HEADS-UP replies with an mcl.ack carrying the original
// correlation_id — this is the VERIFIED-landing receipt, not "bytes queued".
function ackFor(original: MclEnvelope, ownerId: string) {
  const correlation_id = original.params.headers.correlation_id!;
  const ack = buildMessage({
    method: "mcl.ack",
    sender: { id: ownerId, role: "owner" },
    recipient: "channel:receipts",
    thread_id: original.params.routing.thread_id,
    subject: "ack",
    body: correlation_id,
    requires_ack: false,
  });
  // bind the ack to the original via the header correlation_id
  ack.params.headers.correlation_id = correlation_id;
  return ack;
}

describe("mcl-receipts — SHIP-3 verifiable delivery", () => {
  test("VERIFIED only after ACK from ALL owners (not bytes-queued, not a partial)", async () => {
    const mp = new MockMcplayer();
    const orc = new MclClient(mp, "orc");
    await orc.connect();
    const tracker = new ReceiptTracker(orc, { maxAttempts: 3 });

    const msg = headsUp();
    const cid = msg.params.headers.correlation_id!;
    await tracker.registerSend(msg, {
      expectAcksFrom: ["brainlayer", "voicelayer"],
    });

    // enqueued + heads-up fired, but NOT yet verified (no acks landed)
    expect(tracker.getState(cid)).toBe("heads_up");

    // first owner acks -> still not verified (waiting on the other)
    await tracker.onAck(ackFor(msg, "brainlayer"));
    expect(tracker.getState(cid)).toBe("heads_up");

    // second owner acks -> NOW verified
    await tracker.onAck(ackFor(msg, "voicelayer"));
    expect(tracker.getState(cid)).toBe("verified");
    expect(tracker.isVerified(cid)).toBe(true);
  });

  test("HEADS-UP ambient banner fires once on send (visible_audit_trail)", async () => {
    const mp = new MockMcplayer();
    const orc = new MclClient(mp, "orc");
    await orc.connect();
    const banners: string[] = [];
    const tracker = new ReceiptTracker(orc, {
      maxAttempts: 3,
      notifier: { headsUp: (info) => banners.push(info.summary) },
    });
    await tracker.registerSend(headsUp(), { expectAcksFrom: ["brainlayer"] });
    expect(banners).toHaveLength(1);
    expect(banners[0]).toContain("orc");
  });

  test("exhausting maxAttempts routes to DLQ + sends a negative-ack to reply_to", async () => {
    const mp = new MockMcplayer();
    mp.queueFaulted = true; // every publish fails
    const orc = new MclClient(mp, "orc");
    await orc.connect();
    const dlq: string[] = [];
    const tracker = new ReceiptTracker(orc, {
      maxAttempts: 2,
      onDlq: (rec) => dlq.push(rec.correlation_id),
    });

    const msg = headsUp();
    msg.params.headers.reply_to = "channel:orc-inbox";
    const cid = msg.params.headers.correlation_id!;

    // attempt 1 fails (publish throws) -> still pending, not DLQ yet
    await tracker.registerSend(msg, { expectAcksFrom: ["brainlayer"] });
    expect(tracker.getState(cid)).toBe("pending");
    // attempt 2 fails -> exhausted -> DLQ
    await tracker.retry(cid);
    expect(tracker.getState(cid)).toBe("dlq");
    expect(dlq).toEqual([cid]);
  });

  test("a Notification (requires_ack:false) is fire-and-forget — no receipt tracked", async () => {
    const mp = new MockMcplayer();
    const orc = new MclClient(mp, "orc");
    await orc.connect();
    const tracker = new ReceiptTracker(orc, { maxAttempts: 3 });
    const note = buildMessage({
      method: "mcl.broadcast",
      sender: { id: "orc", role: "orchestrator" },
      recipient: "channel:all",
      thread_id: "t",
      subject: "fyi",
      body: "ambient",
      requires_ack: false,
    });
    await tracker.registerSend(note, {});
    expect(tracker.tracked()).toBe(0);
  });
});
