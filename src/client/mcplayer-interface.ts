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
  /** ISO-8601 string from the real daemon (the mock used epoch ms); consumers don't read it. */
  since?: number | string;
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

/**
 * Reserved error codes, pinned to mcplayer PROTOCOL.md v0 for cross-language
 * parser stability. A contained QUEUE-PLANE fault uses the standard JSON-RPC
 * `-32603` (internal error) — NOT an invented code — so the mock and the real
 * daemon agree (resolves the prior mock-only `-32500` divergence; keeps the
 * MockMcplayer→RealMcplayer swap truly zero-change).
 */
export const MCPLAYER_ERR = {
  UNKNOWN_SESSION: -32001,
  UNKNOWN_CHANNEL: -32002,
  ENGINE_NOT_UP: -32003,
  WAL_FULL: -32004,
  QUEUE_FAULT: -32603, // standard JSON-RPC internal error; queue-plane only (A1)
} as const;

/**
 * The 5-method mcplayer surface. AMENDMENTS (locked) + eval-gate clarifications:
 *  A1 — connect()/status() live on a plane SEPARATE from the queue; a queue
 *       fault (McplayerError -32603) must never break them; status() answers
 *       even while the engine is down.
 *  A2 — publish() returns an enqueue-ack OR throws McplayerError(-32004) BUSY
 *       when the bounded WAL is full (never a silent drop).
 *  publish — IDEMPOTENT per (channel, message_id): reuse the SAME message_id on
 *       retry; a re-publish returns the original offset (a fresh id = duplicate
 *       delivery). [eval gap G2]
 *  subscribe — `from_offset` is INCLUSIVE (delivers offset ≥ from_offset);
 *       already-acked messages are skipped regardless. Offsets are monotonic per
 *       channel; resumes across an engine AND an mcplayer restart. [eval gap G1]
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
