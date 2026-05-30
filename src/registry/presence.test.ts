import { describe, test, expect } from "bun:test";
import { foldPresence, toPresenceEvent, type PresenceEvent } from "./presence";
import { buildMessage } from "../schema/envelope";
import { REGISTRY_CHANNEL } from "../schema/channels";

/**
 * The MCL presence registry is event-sourced: register/deregister events on
 * channel:registry are replayed from offset 0 and folded into the current live
 * agent set. `foldPresence` is the pure core — events → live roster.
 */
const reg = (
  id: string,
  offset: number,
  extra: Partial<PresenceEvent> = {},
): PresenceEvent => ({
  kind: "register",
  id,
  offset,
  ...extra,
});
const dereg = (id: string, offset: number): PresenceEvent => ({
  kind: "deregister",
  id,
  offset,
});

describe("foldPresence — event-sourced live roster", () => {
  test("empty event log → empty roster", () => {
    expect(foldPresence([])).toEqual([]);
  });

  test("registers add agents, sorted by id", () => {
    const roster = foldPresence([reg("bravo", 1), reg("alpha", 2)]);
    expect(roster.map((a) => a.id)).toEqual(["alpha", "bravo"]);
  });

  test("deregister removes an agent", () => {
    expect(
      foldPresence([reg("a", 1), reg("b", 2), dereg("a", 3)]).map((x) => x.id),
    ).toEqual(["b"]);
  });

  test("register after deregister revives the agent", () => {
    expect(
      foldPresence([reg("a", 1), dereg("a", 2), reg("a", 3)]).map((x) => x.id),
    ).toEqual(["a"]);
  });

  test("last-write-wins by offset: re-register updates role/last_seen", () => {
    const roster = foldPresence([
      reg("a", 1, { role: "worker", last_seen: 100 }),
      reg("a", 2, { role: "lead", last_seen: 200 }),
    ]);
    expect(roster).toHaveLength(1);
    expect(roster[0]!.role).toBe("lead");
    expect(roster[0]!.last_seen).toBe(200);
  });

  test("events fold deterministically by offset regardless of arrival order", () => {
    // scrambled arrival; correct outcome is decided by offset (dereg@3 wins over reg@1)
    const roster = foldPresence([dereg("a", 3), reg("a", 1), reg("b", 2)]);
    expect(roster.map((x) => x.id)).toEqual(["b"]);
  });

  test("staleMs drops agents whose last_seen is older than now-staleMs", () => {
    const now = 10_000;
    const roster = foldPresence(
      [
        reg("fresh", 1, { last_seen: 9_500 }),
        reg("stale", 2, { last_seen: 1_000 }),
      ],
      { staleMs: 1_000, now },
    );
    expect(roster.map((x) => x.id)).toEqual(["fresh"]);
  });
});

describe("toPresenceEvent — MCL envelope → PresenceEvent", () => {
  test("maps an mcl.register envelope (role + JSON body) into a register event", () => {
    const env = buildMessage({
      method: "mcl.register",
      sender: { id: "worker-1", role: "worker" },
      recipient: REGISTRY_CHANNEL,
      thread_id: "registry",
      subject: "register",
      body: JSON.stringify({
        capabilities: ["search", "code"],
        last_seen: 4242,
      }),
      requires_ack: false,
    });
    const ev = toPresenceEvent(env, 7);
    expect(ev).toEqual({
      kind: "register",
      id: "worker-1",
      role: "worker",
      capabilities: ["search", "code"],
      last_seen: 4242,
      offset: 7,
    });
  });

  test("maps an mcl.deregister envelope into a deregister event", () => {
    const env = buildMessage({
      method: "mcl.deregister",
      sender: { id: "worker-1", role: "worker" },
      recipient: REGISTRY_CHANNEL,
      thread_id: "registry",
      subject: "deregister",
      body: "",
      requires_ack: false,
    });
    expect(toPresenceEvent(env, 9)).toMatchObject({
      kind: "deregister",
      id: "worker-1",
      offset: 9,
    });
  });

  test("a non-registry method maps to null (ignored by the fold)", () => {
    const env = buildMessage({
      method: "mcl.headsup",
      sender: { id: "x", role: "agent" },
      recipient: REGISTRY_CHANNEL,
      thread_id: "t",
      subject: "noise",
      body: "not a presence event",
      requires_ack: false,
    });
    expect(toPresenceEvent(env, 1)).toBeNull();
  });
});
