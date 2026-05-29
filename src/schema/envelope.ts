import { z } from "zod";

/**
 * mcl-schema — the ONE canonical envelope (DECISION-track-4-MCL.md).
 *
 * Wire = JSON-RPC 2.0 (ACP-derived). Three isolation blocks so a busy receiver
 * can screen headers/routing first and skip irrelevant bodies:
 *   - routing  (adapts A2A agent-id / correlation-id)
 *   - headers  (A2A 4.2 metadata — broker routes WITHOUT parsing the body)
 *   - payload  (collaborative intent; aligns with OpenAI-SDK tool inputs)
 *   - delivery_control (drives the SHIP-3 ACK state machine)
 *
 * JSON-RPC 2.0 discipline is LOAD-BEARING:
 *   has `id`  => Request      (requires a response/ACK)
 *   no  `id`  => Notification (fire-and-forget; server MUST NOT respond)
 */

export const MclMethod = z.enum([
  "mcl.handoff",
  "mcl.headsup",
  "mcl.ack",
  "mcl.broadcast",
]);
export type MclMethod = z.infer<typeof MclMethod>;

export const RoutingBlock = z.object({
  message_id: z.string().min(1),
  thread_id: z.string().min(1),
  sender: z.object({ id: z.string().min(1), role: z.string().min(1) }),
  recipient: z.string().min(1), // agent id or "channel:<name>"
});

export const A2AHeaders = z.object({
  a2a_msg_type: z.string().min(1),
  reply_to: z.string().optional(),
  correlation_id: z.string().optional(),
  agent_id: z.string().min(1),
});

export const PayloadBlock = z.object({
  subject: z.string(),
  body: z.string(),
  artifacts: z.array(z.string()).default([]),
});

export const DeliveryControl = z.object({
  requires_ack: z.boolean(),
  max_delivery_attempts: z.number().int().positive(),
  visible_audit_trail: z.boolean(),
});

export const MclParams = z.object({
  routing: RoutingBlock,
  headers: A2AHeaders,
  payload: PayloadBlock,
  delivery_control: DeliveryControl,
});
export type MclParams = z.infer<typeof MclParams>;

const baseShape = {
  jsonrpc: z.literal("2.0"),
  method: MclMethod,
  params: MclParams,
} as const;

/** Request: carries an `id`. */
export const MclRequest = z.object({
  ...baseShape,
  id: z.union([z.string(), z.number()]),
});
export type MclRequest = z.infer<typeof MclRequest>;

/** Notification: strict — an `id` here is a protocol violation and is rejected. */
export const MclNotification = z.strictObject({ ...baseShape });
export type MclNotification = z.infer<typeof MclNotification>;

/** Structural union. Consistency (has-id ⟺ requires_ack) is enforced by buildMessage. */
export const MclEnvelope = z.union([MclRequest, MclNotification]);
export type MclEnvelope = z.infer<typeof MclEnvelope>;

export function isRequest(env: MclEnvelope): env is MclRequest {
  return (env as { id?: unknown }).id !== undefined;
}

const METHOD_TO_A2A: Record<MclMethod, string> = {
  "mcl.handoff": "task.handoff",
  "mcl.headsup": "task.headsup",
  "mcl.ack": "task.ack",
  "mcl.broadcast": "task.broadcast",
};

export interface BuildInput {
  method: MclMethod;
  sender: { id: string; role: string };
  recipient: string;
  thread_id: string;
  subject: string;
  body: string;
  requires_ack: boolean;
  artifacts?: string[];
  max_delivery_attempts?: number;
  visible_audit_trail?: boolean;
  /** override id (else a uuid is generated for ack-required messages) */
  id?: string;
  message_id?: string;
}

/**
 * Build a canonical envelope. INVARIANT: requires_ack === true produces a
 * Request (with id + correlation_id); requires_ack === false produces a
 * Notification (no id). This is the only place the invariant is established.
 */
export function buildMessage(input: BuildInput): MclEnvelope {
  const message_id = input.message_id ?? crypto.randomUUID();
  const params: MclParams = {
    routing: {
      message_id,
      thread_id: input.thread_id,
      sender: input.sender,
      recipient: input.recipient,
    },
    headers: {
      a2a_msg_type: METHOD_TO_A2A[input.method],
      agent_id: input.sender.id,
    },
    payload: {
      subject: input.subject,
      body: input.body,
      artifacts: input.artifacts ?? [],
    },
    delivery_control: {
      requires_ack: input.requires_ack,
      max_delivery_attempts: input.max_delivery_attempts ?? 3,
      visible_audit_trail: input.visible_audit_trail ?? true,
    },
  };

  if (input.requires_ack) {
    const id = input.id ?? crypto.randomUUID();
    params.headers.correlation_id = String(id);
    return MclRequest.parse({
      jsonrpc: "2.0",
      id,
      method: input.method,
      params,
    });
  }
  return MclNotification.parse({
    jsonrpc: "2.0",
    method: input.method,
    params,
  });
}

/** Serialize to a single NDJSON line (one object per line, trailing newline). */
export function serialize(env: MclEnvelope): string {
  return JSON.stringify(env) + "\n";
}

/** Parse + validate a single NDJSON line. Throws ZodError on a malformed envelope. */
export function parseLine(line: string): MclEnvelope {
  return MclEnvelope.parse(JSON.parse(line.trim()));
}
