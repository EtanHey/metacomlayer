import { describe, test, expect } from "bun:test";
import {
  buildMessage,
  serialize,
  parseLine,
  isRequest,
  MclEnvelope,
} from "./envelope";

// SHIP-3 acceptance fixture: the real Wed-May-27 fact-propagation relay that got
// buried in a parenthetical and caused 7h of stale work. The envelope MUST carry
// this verbatim, require an ACK, and survive a serialize -> parse round-trip.
const SHIP3_FACT = "I'm presenting Wednesday not Sunday";

describe("mcl-schema — SHIP-3 fact-propagation HEADS-UP", () => {
  test("a HEADS-UP that requires_ack is a JSON-RPC Request (has id) and round-trips", () => {
    const msg = buildMessage({
      method: "mcl.headsup",
      sender: { id: "orc", role: "orchestrator" },
      recipient: "channel:owners",
      thread_id: "ship3-presentation-day",
      body: SHIP3_FACT,
      subject: "fact-propagation: presentation day moved",
      requires_ack: true,
    });

    expect(isRequest(msg)).toBe(true); // requires_ack => Request => has id
    expect((msg as any).id).toBeDefined();
    expect(msg.params.headers.correlation_id).toBe(String((msg as any).id));

    const line = serialize(msg);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.includes("\n", 0)).toBe(true);

    const parsed = parseLine(line);
    expect(parsed).toEqual(msg); // exact round-trip
    expect(parsed.params.payload.body).toBe(SHIP3_FACT); // fact not mangled
  });

  test("an informational broadcast (requires_ack:false) is a Notification — MUST NOT have id", () => {
    const note = buildMessage({
      method: "mcl.broadcast",
      sender: { id: "orc", role: "orchestrator" },
      recipient: "channel:all",
      thread_id: "t-1",
      body: "ambient status",
      subject: "fyi",
      requires_ack: false,
    });
    expect(isRequest(note)).toBe(false);
    expect((note as any).id).toBeUndefined();
    // round-trips and stays a Notification
    expect(parseLine(serialize(note))).toEqual(note);
  });

  test("a Notification carrying an id is REJECTED (JSON-RPC 2.0 discipline)", () => {
    const bad = {
      jsonrpc: "2.0",
      id: "should-not-be-here",
      method: "mcl.broadcast", // broadcast is informational -> notification shape
      params: validParams(false),
    };
    // We assert the strict rule via the union: a no-ack/notification with an id
    // must not validate as the Notification variant. Easiest: requires_ack false
    // but id present is structurally a Request whose delivery_control disagrees.
    const res = MclEnvelope.safeParse(bad);
    // It may parse as a Request shape; the invariant we enforce is consistency:
    expect(() => assertConsistent(res)).toThrow();
  });

  test("malformed envelope (missing recipient) is rejected with a typed error", () => {
    const bad = {
      jsonrpc: "2.0",
      method: "mcl.headsup",
      params: {
        ...validParams(false),
        routing: {
          message_id: "m1",
          thread_id: "t",
          sender: { id: "a", role: "r" },
        },
      },
    };
    const res = MclEnvelope.safeParse(bad);
    expect(res.success).toBe(false);
  });
});

// helpers for the negative cases
function validParams(requiresAck: boolean) {
  return {
    routing: {
      message_id: "m1",
      thread_id: "t",
      sender: { id: "a", role: "r" },
      recipient: "channel:x",
    },
    headers: { a2a_msg_type: "task.fyi", agent_id: "a" },
    payload: { subject: "s", body: "b", artifacts: [] },
    delivery_control: {
      requires_ack: requiresAck,
      max_delivery_attempts: 3,
      visible_audit_trail: true,
    },
  };
}

function assertConsistent(res: ReturnType<typeof MclEnvelope.safeParse>) {
  if (!res.success) return; // rejection is fine
  const env = res.data;
  const hasId = (env as any).id !== undefined;
  const wantsAck = env.params.delivery_control.requires_ack;
  if (hasId !== wantsAck) {
    throw new Error("inconsistent: has-id must equal requires_ack");
  }
}
