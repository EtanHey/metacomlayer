# 🤖 Bugbot Review: RealMcplayer Client

**PR:** `feat/real-mcplayer-client` — RealMcplayer zero-MCL-change UDS/NDJSON swap  
**Status:** ✅ 24 tests pass, 0 type errors  
**Reviewed:** 2026-05-29

---

## Summary

The implementation is **solid and production-ready** with excellent test coverage. The core protocol implementation is correct, and the zero-MCL-change promise holds. However, there are **7 production-critical issues** and **5 test/maintainability improvements** that should be addressed before merging.

**Severity:**
- 🔴 **Critical (3)** — memory leaks, unbounded buffer growth, silent handler failures
- 🟡 **High (4)** — error visibility, resource cleanup, type safety
- 🟢 **Medium (5)** — test isolation, code quality

---

## 🔴 Critical Issues

### 1. **Unbounded buffer growth (DoS vector)**
**File:** `src/client/real-mcplayer.ts:97-105`  
**Severity:** 🔴 Critical

```typescript
private onData(chunk: string): void {
  this.buf += chunk;  // ← NO SIZE LIMIT
  let nl: number;
  while ((nl = this.buf.indexOf("\n")) >= 0) {
    const line = this.buf.slice(0, nl).trim();
    this.buf = this.buf.slice(nl + 1);
    if (line) this.dispatch(line);
  }
}
```

**Issue:** If a malicious or broken server sends data without newlines, `this.buf` grows unbounded, leading to memory exhaustion.

**Impact:** Denial of service; production daemon bugs could crash MCL clients.

**Fix:**
```typescript
private static readonly MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

private onData(chunk: string): void {
  this.buf += chunk;
  if (this.buf.length > RealMcplayer.MAX_BUFFER_SIZE) {
    this.failAll(new McplayerError(-32000, "buffer overflow - no newline in 1MB"));
    this.close();
    return;
  }
  // ... rest unchanged
}
```

---

### 2. **Silent handler failures — swallowed exceptions**
**File:** `src/client/real-mcplayer.ts:121-125`  
**Severity:** 🔴 Critical

```typescript
if (msg.method === "mcplayer.message" && msg.id === undefined) {
  const m = msg.params as ChannelMessage;
  const handlers = this.channelHandlers.get(m.channel) ?? [];
  for (const h of handlers) void h(m);  // ← thrown errors disappear
  return;
}
```

**Issue:** If a subscription handler throws (e.g., schema validation fails, business logic bug), the exception is silently swallowed by `void`. Other handlers on the same channel never run, and the caller has no visibility.

**Impact:** Silent data loss; debugging production issues requires attaching a debugger.

**Fix:**
```typescript
for (const h of handlers) {
  try {
    const result = h(m);
    if (result instanceof Promise) {
      result.catch(e => {
        // emit to error channel or log; don't let one bad handler break others
        console.error(`[RealMcplayer] handler error on ${m.channel}:`, e);
      });
    }
  } catch (e) {
    console.error(`[RealMcplayer] handler error on ${m.channel}:`, e);
  }
}
```

---

### 3. **Memory leak: channelHandlers never cleaned up**
**File:** `src/client/real-mcplayer.ts:192-198`  
**Severity:** 🔴 Critical

```typescript
unsubscribe: () => {
  const arr = this.channelHandlers.get(p.channel) ?? [];
  this.channelHandlers.set(
    p.channel,
    arr.filter((f) => f !== onMessage),
  );
}
```

**Issue:** 
1. If `subscribe()` is called with the same `onMessage` reference multiple times, only **one** instance is removed per `unsubscribe()`.
2. Empty arrays remain in the Map forever — channels never get deleted even after all subscribers leave.

**Impact:** Long-running processes (orchestrators) that dynamically subscribe/unsubscribe will accumulate empty Map entries and stale handlers.

**Fix:**
```typescript
unsubscribe: () => {
  const arr = this.channelHandlers.get(p.channel) ?? [];
  const filtered = arr.filter((f) => f !== onMessage);
  if (filtered.length === 0) {
    this.channelHandlers.delete(p.channel);  // clean up empty channels
  } else {
    this.channelHandlers.set(p.channel, filtered);
  }
}
```

For the duplicate-subscribe issue, either:
- **Document** that re-subscribing with the same handler adds it multiple times (user responsibility)
- **Dedupe** on subscribe: `if (!list.includes(onMessage)) list.push(onMessage);`

---

## 🟡 High Priority

### 4. **No type validation on `mcplayer.message` params**
**File:** `src/client/real-mcplayer.ts:122`  
**Severity:** 🟡 High

```typescript
const m = msg.params as ChannelMessage;
```

**Issue:** No runtime validation that `params` contains `{ channel, message_id, payload, offset }`. If the daemon sends a malformed notification, downstream handlers crash with `undefined` access.

**Impact:** Fragile cross-system boundary; protocol version mismatches cause runtime errors instead of early rejections.

**Fix:**
```typescript
const m = msg.params as ChannelMessage;
if (!m || typeof m.channel !== 'string' || typeof m.offset !== 'number') {
  console.error('[RealMcplayer] malformed mcplayer.message:', msg.params);
  return; // skip malformed notifications
}
```

Or add Zod validation (mcl-schema already uses Zod).

---

### 5. **Silent JSON parse failures**
**File:** `src/client/real-mcplayer.ts:115-119`  
**Severity:** 🟡 High

```typescript
try {
  msg = JSON.parse(line);
} catch {
  return; // ignore unparseable line (partial handled by buffer)
}
```

**Issue:** Parse errors are silently swallowed. Debugging "message never arrived" issues is impossible without logging.

**Impact:** Production incidents require packet captures; no local diagnostics.

**Fix:**
```typescript
} catch (e) {
  console.error('[RealMcplayer] unparseable line:', line.slice(0, 200), e);
  return;
}
```

---

### 6. **Pending requests not failed immediately on close()**
**File:** `src/client/real-mcplayer.ts:213-220`  
**Severity:** 🟡 High

```typescript
close(): void {
  this.closed = true;
  try {
    this.socket.end();
  } catch {
    /* already closed */
  }
}
```

**Issue:** `close()` sets `this.closed = true` and ends the socket, but doesn't call `failAll()` immediately. Pending requests wait for the socket `close` event to fire, which may be delayed or never happen if `socket.end()` throws.

**Impact:** Graceful shutdown leaves promises hanging; tests may timeout.

**Fix:**
```typescript
close(): void {
  if (this.closed) return;
  this.closed = true;
  this.failAll(new McplayerError(-32000, "client closed"));
  try {
    this.socket.end();
  } catch {
    /* already closed */
  }
}
```

---

### 7. **Type inconsistency: `McplayerStatus.since`**
**File:** `src/client/mcplayer-interface.ts:18-19`  
**Severity:** 🟡 High (maintainability)

```typescript
/** ISO-8601 string from the real daemon (the mock used epoch ms); consumers don't read it. */
since?: number | string;
```

**Issue:** The comment says "consumers don't read it," but the type is exposed in the interface. If it's truly unused, it should be removed or marked `@internal`. If it's used, the inconsistency (mock = number, real = string) is a landmine.

**Impact:** Future consumers will hit runtime type errors if they assume `number` (from mock tests) then run against real daemon.

**Recommendation:**
- If unused: remove from interface entirely
- If needed: standardize to `string` (ISO-8601) and fix mock to match
- If compatibility required: document the exact contract in JSDoc

---

## 🟢 Medium Priority (Test Quality)

### 8. **Test global state prevents isolation**
**File:** `src/client/real-mcplayer.test.ts:29-34`  
**Severity:** 🟢 Medium

```typescript
let server: { stop: () => void };
const channels = new Map<string, Chan>();
let capacity = 1024;
const bufs = new WeakMap<object, string>();
const subscribers = new Map<string, Set<{ write: (s: string) => void }>>();
```

**Issue:** Global mutable state shared across all tests. One test can pollute another (e.g., `capacity` mutation on line 217).

**Impact:** Flaky tests; false positives/negatives; hard to run tests in parallel.

**Fix:** Move state into `beforeEach`, or clear state after each test:
```typescript
beforeEach(() => {
  channels.clear();
  subscribers.clear();
  capacity = 1024;
});
```

---

### 9. **Fragile global capacity mutation**
**File:** `src/client/real-mcplayer.test.ts:216-224`

```typescript
test("a -32004 BUSY nack surfaces as McplayerError", async () => {
  capacity = 1;  // ← mutates global
  const mp = await RealMcplayer.open({ socketPath: SOCK });
  await mp.publish({ channel: "channel:busy", message_id: "b1", payload: 1 });
  await expect(
    mp.publish({ channel: "channel:busy", message_id: "b2", payload: 2 }),
  ).rejects.toBeInstanceOf(McplayerError);
  capacity = 1024;  // ← if test throws before this, capacity stays 1
  mp.close();
});
```

**Issue:** If the test fails before `capacity = 1024`, subsequent tests inherit `capacity = 1`.

**Fix:**
```typescript
test("...", async () => {
  const originalCapacity = capacity;
  try {
    capacity = 1;
    // ... test body
  } finally {
    capacity = originalCapacity;
  }
});
```

Or use `beforeEach`/`afterEach` hooks.

---

### 10. **Shared client in ZERO-MCL-CHANGE test (race condition)**
**File:** `src/client/real-mcplayer.test.ts:227-250`

```typescript
test("ZERO-MCL-CHANGE: MclClient works over RealMcplayer exactly as over the mock", async () => {
  const mp = await RealMcplayer.open({ socketPath: SOCK });
  const orc = new MclClient(mp, "orc");
  await orc.connect();
  // ...
  const receiver = new MclClient(mp, "brainlayer");  // ← SAME mp
  await receiver.receive("channel:owners", ({ envelope }) => {
    seen.push(envelope.params.payload.body);
  });
  // ...
});
```

**Issue:** Two `MclClient` instances sharing the same `RealMcplayer`. If `MclClient` calls `mp.subscribe()` internally, both clients' handlers are registered on the same channel. Race condition on message delivery order.

**Impact:** Flaky test; doesn't prove isolation in multi-client scenarios.

**Recommendation:**
- If intentional (testing shared client), add a comment explaining why.
- Otherwise, use separate `RealMcplayer` instances.

---

### 11. **Hard-coded 500ms wait in live-roundtrip**
**File:** `scripts/live-roundtrip.ts:54`

```typescript
await new Promise((r) => setTimeout(r, 500));
```

**Issue:** Arbitrary delay; fails on slow CI or overloaded systems.

**Fix:** Use the same `waitFor()` pattern from the tests (poll until `got.length > 0`).

---

### 12. **Generic waitFor timeout message**
**File:** `src/client/real-mcplayer.test.ts:154`

```typescript
reject(new Error("timeout"));
```

**Issue:** When tests fail, "timeout" provides no context (what were we waiting for?).

**Fix:**
```typescript
function waitFor(pred: () => boolean, ms = 1000, label = 'condition'): Promise<void> {
  return new Promise((resolve, reject) => {
    // ...
    reject(new Error(`timeout waiting for ${label}`));
  });
}

// usage:
await waitFor(() => got.length >= 2, 1000, 'subscribe backlog replay');
```

---

## ✅ What's Good

1. **Protocol conformance is excellent** — all PROTOCOL.md v0 behaviors (idempotency, monotonic offsets, BUSY nack, notification routing) are correctly implemented.
2. **Test coverage is comprehensive** — real socket + full request/response/notification paths exercised.
3. **Zero-MCL-change promise holds** — `Mcplayer` interface unchanged; adapters/receipts untouched.
4. **Error discipline** — `McplayerError` with structured codes; JSON-RPC 2.0 compliance.
5. **Plane separation (A1) enforced** — connection methods don't touch queue state.
6. **Idempotency on `message_id`** — correctly implemented and tested.

---

## Recommendations

### Before Merge (Critical Path)
1. Fix **#1 (buffer overflow)** — production DoS risk
2. Fix **#2 (silent handler failures)** — debugging nightmare
3. Fix **#3 (memory leak)** — long-running process killer

### Before Production Deploy (High Priority)
4. Add **#4 (type validation)** — cross-system robustness
5. Add **#5 (parse error logging)** — incident response
6. Fix **#6 (close() cleanup)** — graceful shutdown

### Post-Merge (Improvements)
7. Resolve **#7 (`since` type)** — interface hygiene
8–12. Fix test isolation and polish

---

## Testing Verification

```bash
$ bun test
✓ 24 tests pass (RealMcplayer conformance over real UDS)

$ bun run typecheck
✓ 0 errors
```

**Live daemon test:** ⏸️ BLOCKED (expected) — `/tmp/mcplayer.sock` not yet on NDJSON surface (D2 pending). The script correctly diagnoses this and exits with clear messaging.

---

## Conclusion

**Ship-ready with fixes.** The core implementation is sound, and the conformance tests prove the contract. Address the 3 critical issues before merge; the rest can follow in a cleanup PR if time-constrained.

**Approved pending Critical fixes** ✅🔧

---

_Generated by @bugbot on 2026-05-29_
