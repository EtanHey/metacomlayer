import { describe, test, expect } from "bun:test";
import { MockMcplayer } from "../client/mock-mcplayer";
import { MclClient } from "../client/client";
import { createMclToolset } from "./mcl-tools";

/**
 * Push / deliver-on-arrival: a poll already waiting must return the INSTANT a
 * message lands (event-driven), not after a fixed interval — and an agent calls
 * poll ONCE (a long block), never a busy retry loop.
 */
describe("mcl-tools — event-driven deliver-on-arrival", () => {
  test("a waiting poll resolves as soon as a message arrives mid-wait", async () => {
    const mp = new MockMcplayer();
    const a = new MclClient(mp, "a");
    const b = new MclClient(mp, "b");
    await a.connect();
    await b.connect();
    const ta = createMclToolset(a, "a");
    const tb = createMclToolset(b, "b");

    const pollP = tb.poll({ channel: "channel:x", wait_ms: 5000 }); // long block, empty inbox
    await new Promise((r) => setTimeout(r, 20)); // let B's subscribe register
    const t0 = Date.now();
    await ta.publish({
      channel: "channel:x",
      subject: "s",
      body: "now",
      requires_ack: false,
    });

    const res = await pollP;
    const elapsed = Date.now() - t0;
    expect(res.messages.map((m) => m.body)).toContain("now");
    expect(elapsed).toBeLessThan(1000); // returned on arrival, nowhere near the 5s ceiling
  });

  test("poll returns immediately if a message is already buffered", async () => {
    const mp = new MockMcplayer();
    const a = new MclClient(mp, "a");
    const b = new MclClient(mp, "b");
    await a.connect();
    await b.connect();
    const ta = createMclToolset(a, "a");
    const tb = createMclToolset(b, "b");

    await ta.publish({
      channel: "channel:y",
      subject: "s",
      body: "already",
      requires_ack: false,
    });
    await tb.poll({ channel: "channel:y", wait_ms: 5000 }); // first poll subscribes + drains backlog
    // publish again, then a fresh poll should get it fast
    await ta.publish({
      channel: "channel:y",
      subject: "s",
      body: "second",
      requires_ack: false,
    });
    const t0 = Date.now();
    const res = await tb.poll({ channel: "channel:y", wait_ms: 5000 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.messages.map((m) => m.body)).toContain("second");
  });
});
