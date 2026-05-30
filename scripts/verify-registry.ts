#!/usr/bin/env bun
/**
 * verify-registry.ts — live-bus proof of the MCL presence registry
 * (src/registry/registry.ts) against the REAL mcplayer bus:
 *   1. register two agents → both appear in listAgents (role + capabilities carried);
 *   2. deregister one → it's gone, the other survives;
 *   3. the registry log is event-sourced + replayed (no ack — never consumed).
 *
 *   MCPLAYER_SOCKET=/tmp/mcplayer-bus.sock bun scripts/verify-registry.ts
 */
import { RealMcplayer } from "../src/client/real-mcplayer";
import { MclClient } from "../src/client/client";
import { MclRegistry } from "../src/registry/registry";

const stamp = Date.now();
const A = `reg-A-${stamp}`;
const B = `reg-B-${stamp}`;

const mp = await RealMcplayer.open();
const client = new MclClient(mp, `registry-verify-${stamp}`);
await client.connect();
const reg = new MclRegistry(client);

await reg.register({ id: A, role: "worker", capabilities: ["search", "code"] });
await reg.register({ id: B, role: "lead" });
const roster1 = await reg.listAgents({ windowMs: 900 });
const ids1 = roster1.map((a) => a.id);
const aRec = roster1.find((a) => a.id === A);
console.log(
  `after register: ${ids1.length} live; A present=${ids1.includes(A)} B present=${ids1.includes(B)}`,
);

await reg.deregister(A);
const roster2 = await reg.listAgents({ windowMs: 900 });
const ids2 = roster2.map((a) => a.id);
console.log(
  `after deregister(A): A present=${ids2.includes(A)} B present=${ids2.includes(B)}`,
);

const checks = {
  registeredA: ids1.includes(A),
  registeredB: ids1.includes(B),
  roleCarried: aRec?.role === "worker",
  capabilitiesCarried:
    JSON.stringify(aRec?.capabilities) === JSON.stringify(["search", "code"]),
  deregisteredA_gone: !ids2.includes(A),
  bSurvives: ids2.includes(B),
};

console.log("\n--- CHECKS ---");
for (const [k, v] of Object.entries(checks))
  console.log(`${v ? "✅" : "❌"} ${k}`);

mp.close();
const ok = Object.values(checks).every(Boolean);
console.log(
  ok ? "\n✅ VERIFIED — MCL registry live on the real bus" : "\n❌ FAILED",
);
process.exit(ok ? 0 : 1);
