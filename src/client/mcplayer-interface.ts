/**
 * The MCL↔mcplayer SEAM CONTRACT (collab/MCP-layer.md, systemsClaude-ACK 2026-05-29).
 *
 * mcplayer (systemsClaude / track-5) owns the durable transport: a persistent
 * local socket whose connection stays up across engine resets. MCL STACKS ON it
 * and builds NO broker. This file is the ENTIRE coupling surface — MCL codes
 * against these 5 methods and mocks them; real mcplayer implements them exactly.
 *
 * Wire: UDS · NDJSON · JSON-RPC 2.0. Reserved errors:
 *   -32001 unknown session · -32002 unknown channel · -32003 engine not-up
 *   -32004 WAL-full / backpressure (BUSY nack)
 */

export type EngineState = "up" | "busy" | "building" | "not-up";

export interface McplayerStatus {
  state: EngineState;
  since?: number;
}

export interface ConnectResult {
  session_id: string;
}

export interface PublishResult {
  enqueued: true;
  offset: number;
}

export interface ChannelMessage {
  channel: string;
  message_id: string;
  payload: unknown;
  offset: number;
}

export interface Subscription {
  unsubscribe(): void;
}

export class McplayerError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = "McplayerError";
  }
}

export const MCPLAYER_ERR = {
  UNKNOWN_SESSION: -32001,
  UNKNOWN_CHANNEL: -32002,
  ENGINE_NOT_UP: -32003,
  WAL_FULL: -32004,
} as const;

/**
 * The 5-method mcplayer surface. AMENDMENTS (locked):
 *  A1 — connect()/status() live on a plane SEPARATE from the queue; a queue
 *       fault must never break them; status() answers even while engine down.
 *  A2 — publish() returns an enqueue-ack OR throws McplayerError(-32004) BUSY
 *       when the bounded WAL is full (never a silent drop). Offsets are
 *       monotonic per channel; subscribe(from_offset) resumes across an
 *       mcplayer restart, replaying un-acked messages.
 */
export interface Mcplayer {
  connect(p: { client_id: string }): Promise<ConnectResult>;
  publish(p: {
    channel: string;
    message_id: string;
    payload: unknown;
    durable?: boolean;
  }): Promise<PublishResult>;
  subscribe(
    p: { channel: string; from_offset: number },
    onMessage: (m: ChannelMessage) => void | Promise<void>,
  ): Promise<Subscription>;
  ack(p: { channel: string; message_id: string }): Promise<{ acked: true }>;
  status(p?: { engine?: string }): Promise<McplayerStatus>;
}
