import { MclEnvelope, isRequest } from "../schema/envelope";
import {
  type Mcplayer,
  type ChannelMessage,
  type Subscription,
  type McplayerStatus,
  McplayerError,
  MCPLAYER_ERR,
} from "./mcplayer-interface";

/**
 * mcl-client — MCL's thin client over the mcplayer seam. Replaces the old
 * `mcl-core-broker`: MCL binds/owns NOTHING; it speaks the 5-method contract.
 * Channel routing + envelope validation live here; durability lives in mcplayer.
 */

export interface ReceivedMessage {
  envelope: MclEnvelope;
  raw: ChannelMessage;
}

export class Backpressure extends Error {
  constructor(public channel: string) {
    super(`mcplayer WAL full (BUSY) on ${channel}`);
    this.name = "Backpressure";
  }
}

export class MclClient {
  private session_id?: string;

  constructor(
    private mcplayer: Mcplayer,
    private clientId: string,
  ) {}

  async connect(): Promise<void> {
    const { session_id } = await this.mcplayer.connect({
      client_id: this.clientId,
    });
    this.session_id = session_id;
  }

  /**
   * Publish an envelope to its routing.recipient channel. Returns the enqueue
   * offset, or throws Backpressure on a BUSY nack (-32004) — the caller/receipts
   * layer decides retry vs DLQ. We NEVER swallow the nack (A2).
   */
  async send(envelope: MclEnvelope): Promise<{ offset: number }> {
    const channel = envelope.params.routing.recipient;
    try {
      const res = await this.mcplayer.publish({
        channel,
        message_id: envelope.params.routing.message_id,
        payload: envelope,
        durable: true,
      });
      return { offset: res.offset };
    } catch (e) {
      if (e instanceof McplayerError && e.code === MCPLAYER_ERR.WAL_FULL) {
        throw new Backpressure(channel);
      }
      throw e;
    }
  }

  /**
   * Subscribe to a channel; each message's payload is re-validated against the
   * canonical schema before the handler sees it (a malformed payload throws,
   * never reaches the agent). from_offset enables resume-after-restart.
   */
  async receive(
    channel: string,
    handler: (m: ReceivedMessage) => void | Promise<void>,
    from_offset = 0,
  ): Promise<Subscription> {
    return this.mcplayer.subscribe({ channel, from_offset }, async (raw) => {
      const envelope = MclEnvelope.parse(raw.payload); // typed boundary
      await handler({ envelope, raw });
    });
  }

  async ack(channel: string, message_id: string): Promise<void> {
    await this.mcplayer.ack({ channel, message_id });
  }

  /** Engine/connection health (up/busy/building/not-up). */
  async status(p?: { engine?: string }): Promise<McplayerStatus> {
    return this.mcplayer.status(p);
  }

  /** Convenience: does this message demand a receipt? (drives the SHIP-3 layer) */
  static requiresReceipt(envelope: MclEnvelope): boolean {
    return isRequest(envelope) && envelope.params.delivery_control.requires_ack;
  }
}
