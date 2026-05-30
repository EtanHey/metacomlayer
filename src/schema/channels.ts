/**
 * Per-agent private channel conventions — the competing-consumer-safe layout
 * every layer on mcplayer must follow (see docs/PUSH-AND-INBOX.md). Centralized
 * here so the MCP toolset, the Claude Stop-hook adapter, and any future adapter
 * agree on the exact channel names.
 */

/** Directed messages TO an agent. Only that agent (or its adapter) consumes it. */
export const inboxChannelFor = (agentId: string) => `channel:inbox:${agentId}`;

/** SHIP-3 receipts for messages an agent SENT. Only that agent consumes it. */
export const ackChannelFor = (agentId: string) => `channel:ack:${agentId}`;

/**
 * The shared presence event log. register/deregister events are published here
 * (durable, NEVER acked); listAgents replays it from offset 0 and folds. A spike
 * confirmed concurrent from_offset:0 subscribers each get the full backlog, so
 * the shared channel is safe for an event-sourced roster.
 */
export const REGISTRY_CHANNEL = "channel:registry";
