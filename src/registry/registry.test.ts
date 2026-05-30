import { describe, test, expect } from "bun:test";
import { MockMcplayer } from "../client/mock-mcplayer";
import { MclClient } from "../client/client";
import { MclRegistry } from "./registry";

/**
 * MclRegistry over a MockMcplayer that models mcplayer's durable WAL + replay.
 * Complements the pure-core unit tests (presence.test.ts) and the real-bus proof
 * (scripts/verify-registry.ts) with fast, bus-free integration coverage of the
 * register → deregister → listAgents round-trip.
 */
const fast = { quietMs: 20, maxMs: 300 };

async function freshRegistry(): Promise<MclRegistry> {
  const mp = new MockMcplayer();
  const client = new MclClient(mp, "registry-test");
  await client.connect();
  return new MclRegistry(client);
}

describe("MclRegistry — bus-backed presence", () => {
  test("register makes an agent appear with role + capabilities", async () => {
    const reg = await freshRegistry();
    await reg.register({ id: "a", role: "worker", capabilities: ["x"] });
    const roster = await reg.listAgents(fast);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      id: "a",
      role: "worker",
      capabilities: ["x"],
    });
  });

  test("deregister removes an agent; peers survive", async () => {
    const reg = await freshRegistry();
    await reg.register({ id: "a" });
    await reg.register({ id: "b" });
    await reg.deregister("a");
    const ids = (await reg.listAgents(fast)).map((x) => x.id);
    expect(ids).toEqual(["b"]);
  });

  test("re-register after deregister revives the agent (last-write-wins)", async () => {
    const reg = await freshRegistry();
    await reg.register({ id: "a", role: "first" });
    await reg.deregister("a");
    await reg.register({ id: "a", role: "back" });
    const roster = await reg.listAgents(fast);
    expect(roster.map((x) => x.id)).toEqual(["a"]);
    expect(roster[0]!.role).toBe("back");
  });

  test("empty registry → empty roster", async () => {
    const reg = await freshRegistry();
    expect(await reg.listAgents(fast)).toEqual([]);
  });
});
