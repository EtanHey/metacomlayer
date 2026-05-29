import {
  type Mcplayer,
  type ChannelMessage,
  type Subscription,
  type McplayerStatus,
  type ConnectResult,
  type PublishResult,
  McplayerError,
} from "./mcplayer-interface";

/**
 * RealMcplayer — the production client for the mcplayer durable-contract surface
 * (EtanHey/mcplayer `docs/PROTOCOL.md` v0). Speaks UDS + NDJSON + JSON-RPC 2.0.
 *
 * This is the zero-MCL-change swap target: it implements the SAME `Mcplayer`
 * interface as `MockMcplayer`, so `MclClient`/receipts/adapters are unchanged —
 * only the wiring (`new MockMcplayer()` → `await RealMcplayer.connectSocket()`)
 * differs. connect/publish/ack/status are JSON-RPC Requests (await matching id);
 * subscribe sends a Request, awaits `{subscribed:true}`, then routes server
 * `mcplayer.message` Notifications to the per-channel handler.
 *
 * Socket path: `MCPLAYER_SOCKET` env, default `/tmp/mcplayer.sock` — never hardcode.
 */

type Resolver = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

interface BunSocketLike {
  write(data: string): number;
  end(): void;
}

export interface RealMcplayerOptions {
  socketPath?: string;
  /** injectable connector for tests (defaults to Bun.connect over a unix socket). */
  connect?: (handlers: {
    onData: (chunk: string) => void;
    onClose: () => void;
  }) => Promise<BunSocketLike>;
}

export class RealMcplayer implements Mcplayer {
  private socket!: BunSocketLike;
  private buf = "";
  private nextId = 1;
  private pending = new Map<string, Resolver>();
  private channelHandlers = new Map<
    string,
    Array<(m: ChannelMessage) => void | Promise<void>>
  >();
  private closed = false;

  private constructor(private opts: RealMcplayerOptions) {}

  /** Open the UDS connection and return a ready client. */
  static async open(opts: RealMcplayerOptions = {}): Promise<RealMcplayer> {
    const c = new RealMcplayer(opts);
    await c.connectSocket();
    return c;
  }

  private resolvedPath(): string {
    return (
      this.opts.socketPath ??
      process.env.MCPLAYER_SOCKET ??
      "/tmp/mcplayer.sock"
    );
  }

  private async connectSocket(): Promise<void> {
    const onData = (chunk: string) => this.onData(chunk);
    const onClose = () => this.onClose();
    if (this.opts.connect) {
      this.socket = await this.opts.connect({ onData, onClose });
      return;
    }
    // default: Bun unix socket
    const path = this.resolvedPath();
    const self = this;
    this.socket = await Bun.connect({
      unix: path,
      socket: {
        data(_s: unknown, d: Uint8Array) {
          self.onData(Buffer.from(d).toString("utf8"));
        },
        close() {
          self.onClose();
        },
        error(_s: unknown, e: unknown) {
          self.failAll(e);
        },
      },
    });
  }

  // ---- NDJSON frame handling ----

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: {
      id?: string | number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore unparseable line (partial handled by buffer)
    }
    // server→client push: subscription delivery
    if (msg.method === "mcplayer.message" && msg.id === undefined) {
      const m = msg.params as ChannelMessage;
      const handlers = this.channelHandlers.get(m.channel) ?? [];
      for (const h of handlers) void h(m);
      return;
    }
    // response to one of our requests
    if (msg.id !== undefined) {
      const waiter = this.pending.get(String(msg.id));
      if (!waiter) return;
      this.pending.delete(String(msg.id));
      if (msg.error)
        waiter.reject(new McplayerError(msg.error.code, msg.error.message));
      else waiter.resolve(msg.result);
    }
  }

  private onClose(): void {
    this.closed = true;
    this.failAll(new McplayerError(-32000, "mcplayer connection closed"));
  }

  private failAll(e: unknown): void {
    for (const [, w] of this.pending) w.reject(e);
    this.pending.clear();
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed)
      return Promise.reject(new McplayerError(-32000, "connection closed"));
    const id = String(this.nextId++);
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        this.socket.write(frame);
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  // ---- the 5-method Mcplayer surface ----

  async connect(p: { client_id: string }): Promise<ConnectResult> {
    return this.request<ConnectResult>("mcplayer.connect", p);
  }

  async publish(p: {
    channel: string;
    message_id: string;
    payload: unknown;
    durable?: boolean;
  }): Promise<PublishResult> {
    // a -32004 BUSY nack surfaces as a rejected McplayerError (handled by mcl-client)
    return this.request<PublishResult>("mcplayer.publish", p);
  }

  async subscribe(
    p: { channel: string; from_offset: number },
    onMessage: (m: ChannelMessage) => void | Promise<void>,
  ): Promise<Subscription> {
    const list = this.channelHandlers.get(p.channel) ?? [];
    list.push(onMessage);
    this.channelHandlers.set(p.channel, list);
    await this.request<{ subscribed: true }>("mcplayer.subscribe", p);
    return {
      unsubscribe: () => {
        const arr = this.channelHandlers.get(p.channel) ?? [];
        this.channelHandlers.set(
          p.channel,
          arr.filter((f) => f !== onMessage),
        );
      },
    };
  }

  async ack(p: {
    channel: string;
    message_id: string;
  }): Promise<{ acked: true }> {
    return this.request<{ acked: true }>("mcplayer.ack", p);
  }

  async status(p?: { engine?: string }): Promise<McplayerStatus> {
    return this.request<McplayerStatus>("mcplayer.status", p ?? {});
  }

  close(): void {
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* already closed */
    }
  }
}
