import { type MclClient, Backpressure } from "../client/client";
import { isRequest, type MclEnvelope } from "../schema/envelope";

/**
 * mcl-receipts — the SHIP-3 Verifiable Delivery state machine.
 *
 * Kills "fake delivery": a requires_ack message is VERIFIED only when an ACK
 * carrying its correlation_id lands from EVERY expected owner — not when bytes
 * are queued. Three temporal stages + DLQ:
 *
 *   enqueued  -> the broker accepted the publish (objective fact, in the WAL)
 *   heads_up  -> an ambient, non-intrusive banner was raised (no focus steal)
 *   verified  -> ACK received from ALL expected owners
 *   dlq       -> max_delivery_attempts exhausted; negative-ack to reply_to
 *
 * Retries are DRIVEN (retry()/sweep) not timer-internal, so the layer is
 * timer-agnostic and tests are deterministic; the host wires the backoff clock.
 */

export type ReceiptState =
  | "pending"
  | "enqueued"
  | "heads_up"
  | "verified"
  | "dlq";

export interface HeadsUpInfo {
  correlation_id: string;
  channel: string;
  sender: string;
  summary: string;
}

export interface Notifier {
  headsUp(info: HeadsUpInfo): void;
}

export interface ReceiptRecord {
  correlation_id: string;
  channel: string;
  envelope: MclEnvelope;
  expectAcksFrom: string[];
  ackedBy: Set<string>;
  attempts: number;
  state: ReceiptState;
}

export interface ReceiptOptions {
  maxAttempts: number;
  notifier?: Notifier;
  onDlq?: (rec: ReceiptRecord) => void;
}

const NOOP_NOTIFIER: Notifier = { headsUp: () => {} };

export class ReceiptTracker {
  private records = new Map<string, ReceiptRecord>();

  constructor(
    private client: MclClient,
    private opts: ReceiptOptions,
  ) {}

  /**
   * Send an envelope. Notifications (no ack required) are fire-and-forget and
   * leave no receipt. Requests open a receipt and attempt delivery once.
   */
  async registerSend(
    envelope: MclEnvelope,
    p: { expectAcksFrom?: string[] },
  ): Promise<void> {
    if (
      !isRequest(envelope) ||
      !envelope.params.delivery_control.requires_ack
    ) {
      await this.client.send(envelope); // fire-and-forget
      return;
    }
    const expectAcksFrom = p.expectAcksFrom ?? [];
    if (expectAcksFrom.length === 0) {
      throw new Error(
        "requires_ack messages must specify expectAcksFrom (non-empty)",
      );
    }
    const correlation_id = envelope.params.headers.correlation_id!;
    const rec: ReceiptRecord = {
      correlation_id,
      channel: envelope.params.routing.recipient,
      envelope,
      expectAcksFrom,
      ackedBy: new Set(),
      attempts: 0,
      state: "pending",
    };
    this.records.set(correlation_id, rec);
    await this.attempt(rec);
  }

  /** Retry a still-pending record (host drives this on its backoff schedule). */
  async retry(correlation_id: string): Promise<void> {
    const rec = this.records.get(correlation_id);
    if (!rec || rec.state === "verified" || rec.state === "dlq") return;
    await this.attempt(rec);
  }

  /** Record an inbound ACK. Verifies the receipt once ALL owners have acked. */
  async onAck(ack: MclEnvelope): Promise<void> {
    const cid = ack.params.headers.correlation_id;
    if (!cid) return;
    const rec = this.records.get(cid);
    if (!rec || rec.state === "dlq") return;
    rec.ackedBy.add(ack.params.routing.sender.id);
    const allAcked =
      rec.expectAcksFrom.length > 0 &&
      rec.expectAcksFrom.every((owner) => rec.ackedBy.has(owner));
    if (allAcked) rec.state = "verified";
  }

  getState(correlation_id: string): ReceiptState | undefined {
    return this.records.get(correlation_id)?.state;
  }

  isVerified(correlation_id: string): boolean {
    return this.getState(correlation_id) === "verified";
  }

  tracked(): number {
    return this.records.size;
  }

  // ---- internals ----

  private async attempt(rec: ReceiptRecord): Promise<void> {
    rec.attempts += 1;
    try {
      await this.client.send(rec.envelope); // objective fact -> broker WAL
      rec.state = "enqueued";
      this.notifier().headsUp({
        correlation_id: rec.correlation_id,
        channel: rec.channel,
        sender: rec.envelope.params.routing.sender.id,
        summary: `${rec.envelope.params.routing.sender.id} → ${rec.channel}: ${rec.envelope.params.payload.subject}`,
      });
      rec.state = "heads_up";
    } catch (e) {
      // Backpressure (BUSY -32004) or any transport fault: count the attempt,
      // never silently drop. Exhaustion -> DLQ + negative-ack to the originator.
      if (rec.attempts >= this.opts.maxAttempts) {
        await this.toDlq(rec);
      } else {
        rec.state = "pending";
        if (!(e instanceof Backpressure) && !(e as Error)?.message) throw e;
      }
    }
  }

  private async toDlq(rec: ReceiptRecord): Promise<void> {
    rec.state = "dlq";
    this.opts.onDlq?.(rec);
    const reply_to = rec.envelope.params.headers.reply_to;
    if (reply_to) {
      // best-effort negative-ack back to the originator; never throw out of DLQ
      try {
        const { buildMessage } = await import("../schema/envelope");
        const nack = buildMessage({
          method: "mcl.ack",
          sender: { id: "mcl-receipts", role: "system" },
          recipient: reply_to,
          thread_id: rec.envelope.params.routing.thread_id,
          subject: "DLQ: delivery failed",
          body: `correlation_id ${rec.correlation_id} exhausted ${rec.attempts} attempts`,
          requires_ack: false,
        });
        nack.params.headers.correlation_id = rec.correlation_id;
        await this.client.send(nack);
      } catch {
        /* originator unreachable too — record stays dlq for the host to inspect */
      }
    }
  }

  private notifier(): Notifier {
    return this.opts.notifier ?? NOOP_NOTIFIER;
  }
}
