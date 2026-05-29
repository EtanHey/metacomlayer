import { describe, test, expect } from "bun:test";
import { toClaudeChannel, toCodexRpc, fromCursorStreamJson } from "./translate";
import {
  AdapterRegistry,
  LoopbackAdapter,
  type VendorAdapter,
} from "./adapter";
import { MockMcplayer } from "../client/mock-mcplayer";
import { MclClient } from "../client/client";
import { ReceiptTracker } from "../receipts/receipts";
import { buildMessage, type MclEnvelope } from "../schema/envelope";

const OWNERS = "channel:owners";
const SHIP3_FACT = "I'm presenting Wednesday not Sunday";

function headsUp() {
  return buildMessage({
    method: "mcl.headsup",
    sender: { id: "orc", role: "orchestrator" },
    recipient: OWNERS,
    thread_id: "ship3",
    subject: "presentation day",
    body: SHIP3_FACT,
    requires_ack: true,
  });
}
function ackFor(original: MclEnvelope, ownerId: string) {
  const cid = original.params.headers.correlation_id!;
  const ack = buildMessage({
    method: "mcl.ack",
    sender: { id: ownerId, role: "owner" },
    recipient: "channel:receipts",
    thread_id: original.params.routing.thread_id,
    subject: "ack",
    body: cid,
    requires_ack: false,
  });
  ack.params.headers.correlation_id = cid;
  return ack;
}

describe("mcl-adapters — pure translation (correlation_id + body never lost)", () => {
  test("toClaudeChannel preserves body, subject, correlation_id, ack flag", () => {
    const env = headsUp();
    const c = toClaudeChannel(env);
    expect(c.method).toBe("notifications/channel/message");
    expect(c.params.body).toBe(SHIP3_FACT);
    expect(c.params.from).toBe("orc");
    expect(c.params.requires_ack).toBe(true);
    expect(c.params.correlation_id).toBe(env.params.headers.correlation_id);
  });

  test("toCodexRpc is valid JSON-RPC 2.0; ack-required carries an id, fyi does not", () => {
    const env = headsUp();
    const req = toCodexRpc(env);
    expect(req.jsonrpc).toBe("2.0");
    expect(req.id).toBe(env.params.headers.correlation_id); // ack-required => has id
    expect(req.params.text).toContain(SHIP3_FACT);

    const fyi = buildMessage({
      method: "mcl.broadcast",
      sender: { id: "orc", role: "orchestrator" },
      recipient: "channel:all",
      thread_id: "t",
      subject: "s",
      body: "b",
      requires_ack: false,
    });
    expect(toCodexRpc(fyi).id).toBeUndefined(); // Notification => no id
  });

  test("fromCursorStreamJson extracts assistant text, ignores partial/non-assistant lines", () => {
    expect(
      fromCursorStreamJson('{"type":"assistant","message":{"content":"hi"}}'),
    ).toEqual({ text: "hi" });
    expect(fromCursorStreamJson('{"type":"tool_call"}')).toBeNull();
    expect(fromCursorStreamJson('{"type":"assistant","mess')).toBeNull(); // partial line
    expect(fromCursorStreamJson("   ")).toBeNull();
  });
});

describe("AdapterRegistry", () => {
  test("routes by vendor, throws on unknown", () => {
    const reg = new AdapterRegistry();
    const a: VendorAdapter = new LoopbackAdapter("claude");
    reg.register(a);
    expect(reg.get("claude")).toBe(a);
    expect(reg.has("codex")).toBe(false);
    expect(() => reg.get("codex")).toThrow();
  });
});

describe("END-TO-END — SHIP-3 over the full bus (client → mcplayer → adapter → vendor → reply → receipt)", () => {
  test("a HEADS-UP delivered to a (Codex) vendor that replies an ACK reaches VERIFIED", async () => {
    const mp = new MockMcplayer();
    const orc = new MclClient(mp, "orc");
    await orc.connect();
    const tracker = new ReceiptTracker(orc, { maxAttempts: 3 });

    // the Codex-side adapter: when MCL delivers, the fake vendor consumes and
    // replies with an ACK pushed back into MCL via the inbound path.
    let adapter: LoopbackAdapter;
    adapter = new LoopbackAdapter("codex", async (env) => {
      await adapter.pushInbound(ackFor(env, "codex"));
    });
    adapter.onInbound((env) => tracker.onAck(env));

    // 1) orc sends the HEADS-UP (requires_ack) onto the bus
    const msg = headsUp();
    const cid = msg.params.headers.correlation_id!;
    await tracker.registerSend(msg, { expectAcksFrom: ["codex"] });
    expect(tracker.getState(cid)).toBe("heads_up"); // not yet verified

    // 2) the Codex side drains the channel and hands the message to its adapter
    const codexSide = new MclClient(mp, "codex-side");
    await codexSide.connect();
    await codexSide.receive(OWNERS, async ({ envelope }) => {
      await adapter.deliver(envelope);
    });

    // 3) the loop closed: adapter delivered, vendor acked, receipt verified
    expect(adapter.delivered).toHaveLength(1);
    expect(adapter.delivered[0]!.params.payload.body).toBe(SHIP3_FACT);
    expect(tracker.isVerified(cid)).toBe(true);
  });
});
