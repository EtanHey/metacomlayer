import type { MclEnvelope } from "../schema/envelope";

/**
 * mcl-adapters — per-vendor connectivity. An adapter translates the canonical
 * envelope to/from ONE agent CLI's real ingress, so the rest of MCL never
 * touches vendor wire formats. Per the DECISION:
 *   - Claude Code: native `claude/channel` MCP (NOT lifecycle hooks).
 *   - Codex CLI:   WebSocket JSON-RPC 2.0 to the `codex app-server` daemon.
 *   - Cursor CLI:  headless `--resume … --output-format stream-json` capture.
 *
 * All live I/O (HTTP POST / WS / subprocess) is INJECTED so adapters are unit
 * testable; the live cmux A2A smoke (real Claude + real Codex) is the
 * integration-level P3 acceptance, run once agents are spawnable.
 */

export type Vendor = "claude" | "codex" | "cursor";

export interface VendorAdapter {
  readonly vendor: Vendor;
  /** Push a canonical envelope to this vendor's real ingress. */
  deliver(envelope: MclEnvelope): Promise<void>;
  /** Register a handler for envelopes coming BACK from the vendor (replies/acks). */
  onInbound(handler: (env: MclEnvelope) => void | Promise<void>): void;
}

/** Routes a recipient/vendor to its adapter. */
export class AdapterRegistry {
  private byVendor = new Map<Vendor, VendorAdapter>();

  register(adapter: VendorAdapter): void {
    this.byVendor.set(adapter.vendor, adapter);
  }

  get(vendor: Vendor): VendorAdapter {
    const a = this.byVendor.get(vendor);
    if (!a) throw new Error(`no adapter registered for vendor "${vendor}"`);
    return a;
  }

  has(vendor: Vendor): boolean {
    return this.byVendor.has(vendor);
  }
}

/**
 * In-process adapter for end-to-end tests: `deliver` hands the envelope to a
 * fake "vendor" callback; the vendor can push replies back via `pushInbound`.
 * Proves the full bus loop (client → mcplayer → adapter → vendor → reply →
 * receipts) composes without any live CLI.
 */
export class LoopbackAdapter implements VendorAdapter {
  readonly vendor: Vendor;
  private inboundHandlers: Array<(e: MclEnvelope) => void | Promise<void>> = [];
  delivered: MclEnvelope[] = [];

  constructor(
    vendor: Vendor,
    private onDeliver?: (e: MclEnvelope) => void | Promise<void>,
  ) {
    this.vendor = vendor;
  }

  async deliver(envelope: MclEnvelope): Promise<void> {
    this.delivered.push(envelope);
    await this.onDeliver?.(envelope);
  }

  onInbound(handler: (e: MclEnvelope) => void | Promise<void>): void {
    this.inboundHandlers.push(handler);
  }

  /** A fake vendor pushes a reply/ack back into MCL. */
  async pushInbound(env: MclEnvelope): Promise<void> {
    for (const h of this.inboundHandlers) await h(env);
  }
}
