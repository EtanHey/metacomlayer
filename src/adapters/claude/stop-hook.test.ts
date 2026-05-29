import { describe, test, expect } from "bun:test";
import { formatStopDecision, type DrainedMessage } from "./stop-hook";

/**
 * The Claude push adapter is a Stop hook: at the turn boundary it drains the
 * agent's MCL inbox and, if mail is waiting, returns `{decision:"block",reason}`
 * so the message enters the agent's NEXT turn OUT-OF-BAND (never the input line,
 * no polling). `formatStopDecision` is the pure core: drained messages → the
 * Stop-hook decision the agent acts on.
 */
describe("formatStopDecision — Stop-hook out-of-band push payload", () => {
  test("returns null on an empty inbox so the agent is allowed to stop", () => {
    expect(formatStopDecision([])).toBeNull();
  });

  test("blocks with a reason that lists each message, oldest-first by offset", () => {
    const items: DrainedMessage[] = [
      { from: "etan", body: "moved to Wednesday", offset: 2, message_id: "m2" },
      { from: "agent-b", body: "ping", offset: 1, message_id: "m1" },
    ];

    const d = formatStopDecision(items);

    expect(d).not.toBeNull();
    expect(d!.decision).toBe("block");
    // sorted by offset → agent-b (#1) appears before etan (#2)
    expect(d!.reason.indexOf("agent-b")).toBeLessThan(
      d!.reason.indexOf("etan"),
    );
    expect(d!.reason).toContain("moved to Wednesday");
    expect(d!.reason).toContain("2 message");
  });

  test("the reason makes explicit the agent did NOT poll for these", () => {
    const d = formatStopDecision([
      { from: "x", body: "hi", offset: 0, message_id: "m0" },
    ]);
    expect(d!.reason).toContain("did NOT poll");
  });

  test("a 5-message burst is delivered in offset order, not arrival order", () => {
    // arrival order scrambled (the bug the old injection daemon hit: #4,#3,#5,#2,#1)
    const scrambled: DrainedMessage[] = [4, 3, 5, 2, 1].map((n) => ({
      from: "burst",
      body: `msg ${n}`,
      offset: n,
      message_id: `m${n}`,
    }));
    const reason = formatStopDecision(scrambled)!.reason;
    const order = [1, 2, 3, 4, 5].map((n) => reason.indexOf(`msg ${n}`));
    // each appears, and strictly increasing position → ascending offset order
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
