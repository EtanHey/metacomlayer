import type { MclEnvelope } from "../schema/envelope";

/**
 * Pure translation between the canonical envelope and each vendor's wire shape.
 * These are the real, deterministic core of each adapter (no I/O). The exact
 * vendor field names are FIRST-CUT and must be validated against the live CLIs
 * in the cmux A2A smoke; the invariants asserted in tests (correlation_id and
 * body are never lost, output is valid for the vendor's transport) hold
 * regardless of cosmetic field renames.
 */

/**
 * Claude Code ⟸ `claude/channel` MCP notification shape. FUTURE-ONLY: kept for
 * when Claude Code ships `--channels`. The LIVE Claude push is the Stop hook
 * (`src/adapters/claude/stop-hook.ts`), not this notification. */
export interface ClaudeChannelMessage {
  method: "notifications/channel/message";
  params: {
    from: string;
    subject: string;
    body: string;
    correlation_id?: string;
    requires_ack: boolean;
  };
}

export function toClaudeChannel(env: MclEnvelope): ClaudeChannelMessage {
  return {
    method: "notifications/channel/message",
    params: {
      from: env.params.routing.sender.id,
      subject: env.params.payload.subject,
      body: env.params.payload.body,
      correlation_id: env.params.headers.correlation_id,
      requires_ack: env.params.delivery_control.requires_ack,
    },
  };
}

/** Codex CLI ⟸ JSON-RPC 2.0 to the `codex app-server` (Threads/Turns inject). */
export interface CodexRpc {
  jsonrpc: "2.0";
  id?: string;
  method: "channel/inject";
  params: { thread_id: string; text: string; correlation_id?: string };
}

export function toCodexRpc(env: MclEnvelope): CodexRpc {
  const rpc: CodexRpc = {
    jsonrpc: "2.0",
    method: "channel/inject",
    params: {
      thread_id: env.params.routing.thread_id,
      text: `${env.params.payload.subject}\n\n${env.params.payload.body}`,
      correlation_id: env.params.headers.correlation_id,
    },
  };
  // ack-required => JSON-RPC Request (carries id); else Notification (no id)
  if (
    env.params.delivery_control.requires_ack &&
    env.params.headers.correlation_id
  ) {
    rpc.id = env.params.headers.correlation_id;
  }
  return rpc;
}

/** Cursor CLI ⟹ a captured `--output-format stream-json` event (observational). */
export interface CursorStreamEvent {
  type: string;
  message?: { role?: string; content?: string };
}

/** Extract the assistant text Cursor emitted on stdout (capture mode). */
export function fromCursorStreamJson(line: string): { text: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let ev: CursorStreamEvent;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return null; // partial / non-JSON line — caller buffers until next newline
  }
  if (ev.type === "assistant" && ev.message?.content) {
    return { text: ev.message.content };
  }
  return null;
}
