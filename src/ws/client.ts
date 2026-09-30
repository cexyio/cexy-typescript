import { CexyError } from "../errors.js";
import { assertSecureUrl } from "../url.js";
import type { Balance, OrderBook } from "../types.js";
import { LiveBalances, type LiveBalancesOptions } from "./balances.js";
import { TypedEmitter } from "./emitter.js";
import { LiveOrderBook, type LiveOrderBookOptions } from "./orderbook.js";
import {
  KNOWN_EVENT_TYPES,
  PRIVATE_CHANNELS,
  SUPPORTED_PROTOCOL_VERSION,
  type ErrorFrame,
  type SessionRevokedEvent,
  type SubscribedFrame,
  type WebSocketConstructor,
  type WebSocketLike,
  type WelcomeFrame,
  type WsEvent,
} from "./types.js";

export const DEFAULT_WS_URL = "wss://api.cexy.io/api/v1/ws";
const MAX_CHANNEL_LENGTH = 64;
const OPEN = 1;

/** A WebSocket protocol error, a server error frame, or a local guard. */
export class CexyWebSocketError extends CexyError {
  readonly code: string;
  /** True when this came from a server `error` frame (not a local guard or disconnect). */
  readonly fromServer: boolean;
  constructor(code: string, message: string, fromServer = false) {
    super(message);
    this.code = code;
    this.fromServer = fromServer;
  }
}

const TEARDOWN_CODES: ReadonlySet<string> = new Set(["DISCONNECTED", "CLOSED"]);

/** Where order-book snapshots come from (a `CexyClient` fits). */
export interface SnapshotSource {
  markets: { orderbook(symbol: string, params?: { depth?: number | null }): Promise<OrderBook> };
  /** Balance snapshots and the key owner's id, for `liveBalances()` (a `CexyClient` fits). */
  account?: { balances(): Promise<Balance[]>; id?(): Promise<string> };
}

/**
 * TEST-ONLY time source for the client's reorder-window timer and `LiveBalances` scheduling
 * (minimum snapshot interval, retry backoff). Socket timeouts (heartbeat, liveness, acks) always
 * use the real clock. Leave unset in production: the default is `Date.now` and `setTimeout`.
 */
export interface WsClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_CLOCK: WsClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Payload of `sequenceGap`. */
export interface SequenceGap {
  channel: string;
  expected: number;
  received: number;
}

interface SeqState {
  next: number | null;
  holes: Set<number>;
  first: SequenceGap | null;
  timer: unknown;
}

export interface WsLogger {
  warn(message: string): void;
  debug?(message: string): void;
}

export interface ReconnectOptions {
  /** Default 1000 ms. */
  baseDelayMs?: number;
  /** Default 30000 ms. */
  maxDelayMs?: number;
  /** Default: unlimited. */
  maxAttempts?: number;
}

export interface CexyWebSocketOptions {
  /** Default `wss://api.cexy.io/api/v1/ws`. Must be `wss://` (see `allowInsecure`). */
  url?: string;
  /** Allow `ws://`, but ONLY for `localhost`, `127.0.0.1` or `::1` (local test servers). Default false. */
  allowInsecure?: boolean;
  /**
   * WebSocket implementation. Default: in Node the optional `ws` package if installed
   * (so a User-Agent can be sent), else the global `WebSocket` (browsers, Node 22+).
   */
  WebSocket?: WebSocketConstructor;
  /** REST client used for order-book snapshots (`CexyClient.websocket()` sets it). */
  restClient?: SnapshotSource;
  /** Client ping cadence. Required by the server; default 30000 ms. */
  pingIntervalMs?: number;
  /** Reconnect if no frame arrives for this long. Default 75000 ms. */
  livenessTimeoutMs?: number;
  /** Default 10000 ms. */
  welcomeTimeoutMs?: number;
  /** How long `subscribe()` waits for `subscribed`. Default 5000 ms. */
  ackTimeoutMs?: number;
  /** Automatic reconnect (default on). */
  reconnect?: boolean | ReconnectOptions;
  /** Local subscription cap. Default 100 (the server's limit). */
  maxSubscriptions?: number;
  /** Local message cap per fixed minute. Default 200 (server closes above 240). */
  maxMessagesPerMinute?: number;
  /** Sent as User-Agent when the implementation allows headers (the `ws` package). */
  userAgent?: string;
  logger?: WsLogger;
  /**
   * Private channels with several publishers (orders, account) can deliver two adjacent frames
   * swapped. A missing sequence number gets this long to arrive before it counts as a gap.
   * Default 250 ms.
   */
  reorderWindowMs?: number;
  /** TEST-ONLY: see `WsClock`. */
  clock?: WsClock;
  /** @internal deterministic jitter in tests */
  random?: () => number;
}

export interface SubscribeResult {
  /** Channels the server confirmed as newly added. */
  added: string[];
  /** Channels refused locally because the subscription cap was reached. */
  refused: string[];
  /** Channels already held (nothing sent for them). */
  alreadySubscribed: string[];
}

export interface CloseInfo {
  code: number | undefined;
  reason: string | undefined;
  willReconnect: boolean;
}

/**
 * `reauth`: private channels were re-subscribed after the server signed the connection out
 * or switched it to another account; refetch private state through REST.
 */
export type ResyncReason =
  | "concurrent_modification"
  | "reconnect"
  | "reauth"
  /** A private channel skipped sequence numbers (see `sequenceGap`). */
  | "sequence_gap"
  /** `balances.resync`: the server could not resume its balance change stream. */
  | "balances_resync"
  /** `deposits.resync` (planned server frame): refetch the deposit list. */
  | "deposits_resync"
  /** `withdrawals.resync` (planned server frame): refetch the withdrawal list. */
  | "withdrawals_resync";

/**
 * Why the server stopped the connection's private subscriptions (see `authChanged`). May grow:
 * `signed_out` covers a server sign-out with a reason this SDK does not know (raw value in `code`).
 */
export type AuthChangeReason = "user_changed" | "auth_failed" | "session_revoked" | "token_expired" | "signed_out";

/** Payload of `authChanged`. */
export interface AuthChange {
  reason: AuthChangeReason;
  /** The user of the last successful auth on this connection, if any. */
  previousUserId: string | null;
  /** The new user (`user_changed`), otherwise null: the connection is signed out. */
  userId: string | null;
  /** The server's error code (`auth_failed`), or the raw `signed_out` reason (`signed_out`). */
  code?: string;
  /**
   * Private channels the server dropped. They are re-subscribed automatically: at once for
   * `user_changed`, after the next successful `auth()` otherwise (then `resync` "reauth").
   */
  dropped: string[];
}

export interface CexyWebSocketEvents extends Record<string, unknown[]> {
  open: [];
  welcome: [WelcomeFrame];
  /** Every known event (`ticker.update`, `orderbook.update`, `order.*`, ...). */
  event: [WsEvent];
  subscribed: [string[]];
  /** `unsubscribed` acknowledgement. */
  unsubscribed: [string[]];
  /** `authenticated` acknowledgement (after `auth()` or the automatic re-auth on reconnect). */
  authenticated: [userId: string | null];
  pong: [id: string | null];
  /** An `error` frame from the server. */
  serverError: [CexyWebSocketError, ErrorFrame];
  /** Transport problems and failed resyncs. */
  error: [Error];
  close: [CloseInfo];
  reconnecting: [{ attempt: number; delayMs: number }];
  /** Reconnected, re-authenticated (if a token was held) and re-subscribed. */
  reconnected: [WelcomeFrame];
  /** State may have been missed: refetch anything you keep from private or public channels. */
  resync: [ResyncReason];
  /**
   * This connection's own session was revoked (`session.revoked` with `current: true`, or
   * the `signed_out` frame with reason `revoked`, delivered as a synthetic event with
   * `channel: "account"` and `data: { session_id: null, reason: "signed_out", current: true }`).
   * Private channels are dead; the socket stays open and public channels keep working. Call
   * `auth()` with a new token to restore private channels.
   */
  authLost: [SessionRevokedEvent];
  /**
   * The server ended this connection's private subscriptions: `auth()` succeeded as another
   * user, an `auth()` failed (the server signs the connection out on any auth error), or this
   * connection's own session was revoked (`session.revoked` with `current: true`).
   */
  authChanged: [AuthChange];
  /**
   * A private channel skipped sequence numbers on this connection (after the reorder window):
   * events were lost. Followed by `resync` with `"sequence_gap"`; refetch that channel's state.
   */
  sequenceGap: [SequenceGap];
}

/** Result of `auth()`. */
export interface AuthResult {
  /** From the `authenticated` acknowledgement; null when queued. */
  userId: string | null;
  /** True when not connected: the token is kept and sent (and acknowledged) on connect. */
  queued: boolean;
}

type RequestKind = "auth" | "subscribe" | "unsubscribe" | "ping";
const ACK_TYPE: Record<RequestKind, string> = {
  auth: "authenticated",
  subscribe: "subscribed",
  unsubscribe: "unsubscribed",
  ping: "pong",
};

interface Pending {
  id: string;
  kind: RequestKind;
  channels: string[];
  resolve: (ack: Record<string, unknown> | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const defaultLogger: WsLogger = { warn: (m) => console.warn(`[cexy] ${m}`) };

/**
 * CEXY.io WebSocket client: heartbeat, liveness, subscriptions with local limits, automatic
 * reconnect with re-auth and re-subscribe, and live order books.
 *
 * API-key authentication on the WebSocket is not available yet: `auth()` takes a session
 * access token. Programs holding only an API key get public channels and poll REST for
 * private state.
 */
export class CexyWebSocket extends TypedEmitter<CexyWebSocketEvents> {
  readonly url: string;
  readonly #opts: Required<
    Pick<CexyWebSocketOptions, "pingIntervalMs" | "livenessTimeoutMs" | "welcomeTimeoutMs" | "ackTimeoutMs" | "maxSubscriptions" | "maxMessagesPerMinute">
  >;
  readonly #reconnect: Required<ReconnectOptions> | null;
  readonly #logger: WsLogger;
  readonly #random: () => number;
  readonly #restClient: SnapshotSource | undefined;
  readonly #userAgent: string | undefined;
  readonly #ctorOption: WebSocketConstructor | undefined;

  #socket: WebSocketLike | null = null;
  #welcome: WelcomeFrame | null = null;
  #channels = new Set<string>();
  #token: string | null = null;
  /** The user of the last successful auth on the current connection. */
  #authUserId: string | null = null;
  /** Private channels dropped by a server sign-out, re-subscribed after the next successful auth. */
  #pendingPrivate = new Set<string>();
  /** Frame-sequence tracking per private channel on the current connection. */
  #seq = new Map<string, SeqState>();
  readonly #clock: WsClock;
  readonly #reorderWindowMs: number;
  #closedByUser = true;
  #everConnected = false;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #livenessTimer: ReturnType<typeof setTimeout> | null = null;
  #pending = new Map<string, Pending>();
  #nextId = 1;
  #windowStart = 0;
  #windowCount = 0;
  #warnedVersion = false;
  #books = new Map<string, LiveOrderBook>();
  #liveBalances = new Set<LiveBalances>();
  /** `balances` was subscribed by `liveBalances()` (unsubscribed when the last helper closes). */
  #balancesByHelper = false;
  #connecting: Promise<WelcomeFrame> | null = null;

  constructor(options: CexyWebSocketOptions = {}) {
    super();
    this.url = options.url ?? DEFAULT_WS_URL;
    let parsed: URL;
    try {
      parsed = new URL(this.url);
    } catch {
      throw new CexyWebSocketError("CONFIG", `invalid WebSocket url: ${this.url}`);
    }
    try {
      assertSecureUrl(parsed, "wss:", "ws:", options.allowInsecure === true, "WebSocket url");
    } catch (err) {
      throw new CexyWebSocketError("CONFIG", (err as Error).message);
    }
    this.#opts = {
      pingIntervalMs: options.pingIntervalMs ?? 30_000,
      livenessTimeoutMs: options.livenessTimeoutMs ?? 75_000,
      welcomeTimeoutMs: options.welcomeTimeoutMs ?? 10_000,
      ackTimeoutMs: options.ackTimeoutMs ?? 5_000,
      maxSubscriptions: options.maxSubscriptions ?? 100,
      maxMessagesPerMinute: options.maxMessagesPerMinute ?? 200,
    };
    const rc = options.reconnect ?? true;
    this.#reconnect =
      rc === false
        ? null
        : {
            baseDelayMs: (rc === true ? undefined : rc.baseDelayMs) ?? 1_000,
            maxDelayMs: (rc === true ? undefined : rc.maxDelayMs) ?? 30_000,
            maxAttempts: (rc === true ? undefined : rc.maxAttempts) ?? Infinity,
          };
    this.#logger = options.logger ?? defaultLogger;
    this.#random = options.random ?? Math.random;
    this.#restClient = options.restClient;
    this.#userAgent = options.userAgent;
    this.#ctorOption = options.WebSocket;
    this.#clock = options.clock ?? REAL_CLOCK;
    this.#reorderWindowMs = options.reorderWindowMs ?? 250;
  }

  /** The last `welcome` frame, or null before the first connection. */
  get welcome(): WelcomeFrame | null {
    return this.#welcome;
  }

  get connected(): boolean {
    return this.#socket?.readyState === OPEN && this.#welcome !== null;
  }

  /** Channels currently held (restored after every reconnect). */
  get channels(): string[] {
    return [...this.#channels];
  }

  /**
   * True while a session token is kept for automatic re-authentication. A refused token and a
   * revoked session are forgotten.
   */
  get hasToken(): boolean {
    return this.#token !== null;
  }

  /** The user of the last successful `auth` on the current connection, or null (signed out). */
  get userId(): string | null {
    return this.#authUserId;
  }

  /** @internal the logger for helpers (`LiveBalances`) */
  get logger(): WsLogger {
    return this.#logger;
  }

  /** @internal the time source for helpers (`LiveBalances`) */
  get clock(): WsClock {
    return this.#clock;
  }

  /** Opens the connection; resolves on the server's `welcome` frame. */
  connect(): Promise<WelcomeFrame> {
    if (this.connected && this.#welcome) return Promise.resolve(this.#welcome);
    if (this.#connecting) return this.#connecting;
    this.#closedByUser = false;
    this.#connecting = this.#open().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  /**
   * Authenticates private channels with a session access token. Resolves on the server's
   * `authenticated` acknowledgement (same request id); rejects on an `error` with that id
   * (the token is then forgotten) or when no acknowledgement arrives within `ackTimeoutMs`.
   * The token is kept in memory and re-sent after each reconnect. When not connected, the
   * token is queued and the promise resolves with `queued: true`.
   * (API-key authentication is not available on the WebSocket yet.)
   */
  auth(token: string): Promise<AuthResult> {
    if (typeof token !== "string" || token === "") throw new CexyWebSocketError("CONFIG", "auth(): token is required");
    this.#token = token;
    if (!this.connected) return Promise.resolve({ userId: null, queued: true });
    const p = this.#auth(token);
    p.catch(() => {}); // callers that ignore the promise must not crash the process
    return p;
  }

  /** Sends a ping with an id and resolves with the round-trip time in ms. */
  async ping(): Promise<number> {
    const started = Date.now();
    await this.#request("ping", {}, [], true);
    return Date.now() - started;
  }

  /**
   * Subscribes to channels, e.g. `["ticker:BTC/USDT", "trades:BTC/USDT"]`. Resolves when the
   * server confirms. Beyond `maxSubscriptions` channels are refused locally (see `refused`).
   */
  async subscribe(channels: string[]): Promise<SubscribeResult> {
    const wanted = [...new Set(channels)];
    for (const c of wanted) {
      if (typeof c !== "string" || c === "" || c.length > MAX_CHANNEL_LENGTH) {
        throw new CexyWebSocketError("CONFIG", `invalid channel name: ${JSON.stringify(c)}`);
      }
    }
    // Private channels waiting for the next successful auth count as held.
    const held = (c: string) => this.#channels.has(c) || this.#pendingPrivate.has(c);
    const alreadySubscribed = wanted.filter(held);
    const fresh = wanted.filter((c) => !held(c));
    const room = Math.max(0, this.#opts.maxSubscriptions - this.#channels.size - this.#pendingPrivate.size);
    const accepted = fresh.slice(0, room);
    const refused = fresh.slice(room);
    if (refused.length) this.#logger.warn(`subscription cap (${this.#opts.maxSubscriptions}) reached; refused: ${refused.join(", ")}`);
    if (accepted.length === 0) return { added: [], refused, alreadySubscribed };
    for (const c of accepted) this.#channels.add(c);
    if (!this.connected) return { added: [], refused, alreadySubscribed };
    let added: string[];
    try {
      added = await this.#sendSubscribe(accepted);
    } catch (err) {
      // Refused by the server (e.g. UNAUTHENTICATED for a private channel): not held.
      if (err instanceof CexyWebSocketError && err.fromServer) for (const c of accepted) this.#channels.delete(c);
      throw err;
    }
    return { added, refused, alreadySubscribed };
  }

  /**
   * Unsubscribes. Resolves on the `unsubscribed` acknowledgement (or after `ackTimeoutMs`
   * without one); rejects on an `error` with the request id.
   */
  async unsubscribe(channels: string[]): Promise<void> {
    for (const c of channels) {
      this.#pendingPrivate.delete(c);
      this.#resetSeq(c);
    }
    const held = [...new Set(channels)].filter((c) => this.#channels.delete(c));
    if (held.length && this.connected) await this.#request("unsubscribe", { channels: held }, held, false);
  }

  /**
   * A live order book for `symbol` that follows the sync rules: subscribe first, then a REST
   * snapshot (sequence S); drop updates with sequence <= S; each update replaces the top 50
   * levels; a gap marks the book stale until the next update; a fresh snapshot after every
   * reconnect and after `CONCURRENT_MODIFICATION`. Resolves after the first snapshot.
   */
  async orderBook(symbol: string, options: LiveOrderBookOptions = {}): Promise<LiveOrderBook> {
    const rest = this.#restClient;
    if (!rest) throw new CexyWebSocketError("CONFIG", "orderBook() needs restClient (use CexyClient.websocket())");
    const existing = this.#books.get(symbol);
    if (existing) return existing;
    const book = new LiveOrderBook(symbol, rest, options, () => {
      this.#books.delete(symbol);
      void this.unsubscribe([`orderbook:${symbol}`]);
    });
    this.#books.set(symbol, book);
    // Subscribe BEFORE taking the snapshot, buffering updates meanwhile.
    const res = await this.subscribe([`orderbook:${symbol}`]);
    if (res.refused.length) {
      this.#books.delete(symbol);
      throw new CexyWebSocketError("LOCAL_SUBSCRIPTION_LIMIT", `cannot subscribe to orderbook:${symbol}: cap reached`);
    }
    await book.resync();
    return book;
  }

  /**
   * Live balances of the authenticated account: subscribes `balances`, takes a REST snapshot,
   * applies newer `balance.updated` events and refetches by itself when events may be missing.
   * Call `auth()` first. Snapshots come from `restClient.account.balances()` (use
   * `CexyClient.websocket()`) or `options.snapshot`; before every merge the snapshot source's
   * owner (`restClient.account.id()`, `options.ownerId` or `options.accountId`) must equal the
   * WebSocket's authenticated user, otherwise nothing is merged (`ACCOUNT_MISMATCH`).
   */
  async liveBalances(options: LiveBalancesOptions = {}): Promise<LiveBalances> {
    const account = this.#restClient?.account;
    const snapshot = options.snapshot ?? (account ? () => account.balances() : undefined);
    if (!snapshot) throw new CexyWebSocketError("CONFIG", "liveBalances() needs options.snapshot or restClient (use CexyClient.websocket())");
    const fixed = options.accountId;
    const accountId = account?.id?.bind(account);
    const ownerId = options.ownerId ?? (fixed !== undefined ? () => Promise.resolve(fixed) : accountId);
    if (!ownerId) {
      throw new CexyWebSocketError("CONFIG", "liveBalances() needs options.ownerId or options.accountId to check the snapshot's account");
    }
    const helper = new LiveBalances(this, { ...options, snapshot, ownerId });
    this.#liveBalances.add(helper);
    const res = await this.subscribe(["balances"]);
    if (res.refused.length) {
      helper.close();
      throw new CexyWebSocketError("LOCAL_SUBSCRIPTION_LIMIT", "cannot subscribe to balances: cap reached");
    }
    if (!res.alreadySubscribed.includes("balances")) this.#balancesByHelper = true;
    // Acknowledged now: the `subscribed` reply already triggered the first snapshot. Held already
    // (by the caller or another helper): no reply comes, so start here.
    if (res.alreadySubscribed.includes("balances")) helper.start();
    return helper;
  }

  /** @internal a `LiveBalances` closed */
  releaseBalances(helper: LiveBalances): void {
    this.#liveBalances.delete(helper);
    if (this.#liveBalances.size === 0 && this.#balancesByHelper) {
      this.#balancesByHelper = false;
      void this.unsubscribe(["balances"]).catch(() => {});
    }
  }

  /** Closes the connection for good (no reconnect). */
  close(): void {
    this.#closedByUser = true;
    this.#authUserId = null;
    this.#resetSeq();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    for (const b of [...this.#books.values()]) b.markDisconnected();
    const s = this.#socket;
    this.#teardown(new CexyWebSocketError("CLOSED", "connection closed by client"));
    if (s) {
      try {
        s.close(1000, "client closing");
      } catch {
        /* ignore */
      }
    }
    this.emit("close", { code: 1000, reason: "client closing", willReconnect: false });
  }

  // ---------------------------------------------------------------------------------------

  async #open(): Promise<WelcomeFrame> {
    const Ctor = await this.#resolveCtor();
    return new Promise<WelcomeFrame>((resolve, reject) => {
      let settled = false;
      const socket = Ctor.native
        ? new Ctor.ctor(this.url)
        : new Ctor.ctor(this.url, this.#userAgent ? { headers: { "User-Agent": this.#userAgent } } : undefined);
      this.#socket = socket;
      const welcomeTimer = setTimeout(() => fail(new CexyWebSocketError("TIMEOUT", "no welcome frame from server")), this.#opts.welcomeTimeoutMs);
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(welcomeTimer);
        this.#detach(socket);
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        if (this.#socket === socket) this.#socket = null;
        reject(err);
      };

      socket.onopen = () => {
        this.#startHeartbeat();
        this.emit("open");
      };
      socket.onerror = () => {
        if (!settled) fail(new CexyWebSocketError("CONNECT_FAILED", `could not connect to ${this.url}`));
      };
      socket.onclose = (ev) => {
        if (!settled) {
          fail(new CexyWebSocketError("CONNECT_FAILED", `connection closed before welcome (code ${ev?.code ?? "?"})`));
          return;
        }
        if (this.#socket === socket) this.#onDropped(ev?.code, ev?.reason);
      };
      socket.onmessage = (ev) => {
        const frame = parseFrame(ev.data);
        if (!frame) return;
        this.#touch();
        if (!settled && frame["type"] === "welcome") {
          settled = true;
          clearTimeout(welcomeTimer);
          const welcome = this.#onWelcome(frame as unknown as WelcomeFrame);
          resolve(welcome);
          return;
        }
        this.#onFrame(frame);
      };
    });
  }

  async #resolveCtor(): Promise<{ ctor: WebSocketConstructor; native: boolean }> {
    if (this.#ctorOption) return { ctor: this.#ctorOption, native: true };
    const g = globalThis as { process?: { versions?: { node?: string } }; WebSocket?: WebSocketConstructor };
    if (g.process?.versions?.node) {
      try {
        const name = "ws";
        const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ name)) as {
          WebSocket?: WebSocketConstructor;
          default?: WebSocketConstructor | { WebSocket?: WebSocketConstructor };
        };
        const def = mod.default;
        const ctor = mod.WebSocket ?? (typeof def === "function" ? def : def?.WebSocket);
        if (ctor) return { ctor, native: false };
      } catch {
        /* optional peer not installed */
      }
    }
    if (g.WebSocket) return { ctor: g.WebSocket, native: true };
    throw new CexyWebSocketError("NO_WEBSOCKET", "no WebSocket implementation: install the `ws` package or use Node 22+");
  }

  #onWelcome(welcome: WelcomeFrame): WelcomeFrame {
    this.#welcome = welcome;
    if (welcome.protocol_version !== SUPPORTED_PROTOCOL_VERSION && !this.#warnedVersion) {
      this.#warnedVersion = true;
      this.#logger.warn(
        `server protocol_version ${welcome.protocol_version} is newer than this SDK supports (${SUPPORTED_PROTOCOL_VERSION}); continuing`,
      );
    }
    this.#authUserId = null; // a new connection starts signed out
    this.#resetSeq(); // sequences on a new connection are unrelated
    const isReconnect = this.#everConnected;
    this.#everConnected = true;
    this.#reconnectAttempt = 0;
    this.emit("welcome", welcome);
    if (isReconnect) {
      if (this.#token) this.#reAuth(this.#token);
      const channels = [...this.#channels];
      if (channels.length) {
        this.#sendSubscribe(channels).catch((err: unknown) => this.#emitError(err));
      }
      this.emit("reconnected", welcome);
      this.emit("resync", "reconnect");
      for (const b of this.#books.values()) void b.resync();
    } else if (this.#channels.size) {
      // Channels queued before the first connection.
      if (this.#token) this.#reAuth(this.#token);
      this.#sendSubscribe([...this.#channels]).catch((err: unknown) => this.#emitError(err));
    } else if (this.#token) {
      this.#reAuth(this.#token);
    }
    return welcome;
  }

  #onFrame(frame: Record<string, unknown>): void {
    const type = frame["type"];
    switch (type) {
      case "welcome":
        this.#onWelcome(frame as unknown as WelcomeFrame);
        return;
      case "pong": {
        // Replies to our pings echo the id; the server's own pongs every 30 s have none.
        const id = typeof frame["id"] === "string" ? frame["id"] : null;
        if (id !== null) this.#settle(id, "ping", frame);
        this.emit("pong", id);
        return;
      }
      case "authenticated": {
        const id = typeof frame["id"] === "string" ? frame["id"] : null;
        if (id !== null) this.#settle(id, "auth", frame);
        const userId = typeof frame["user_id"] === "string" ? frame["user_id"] : null;
        this.emit("authenticated", userId);
        this.#onAuthenticated(userId);
        return;
      }
      case "subscribed":
      case "unsubscribed": {
        const f = frame as unknown as SubscribedFrame;
        const channels = Array.isArray(f.channels) ? f.channels.filter((c): c is string => typeof c === "string") : [];
        const kind = type === "subscribed" ? "subscribe" : "unsubscribe";
        const id = typeof f.id === "string" ? f.id : null;
        if (id !== null) this.#settle(id, kind, frame);
        else {
          // Legacy-safe fallback for an acknowledgement without an id: match by channel.
          for (const p of this.#pending.values()) {
            if (p.kind === kind && channels.some((c) => p.channels.includes(c))) {
              this.#settle(p.id, kind, frame);
              break;
            }
          }
        }
        if (type === "subscribed") {
          for (const c of channels) this.#resetSeq(c); // the next frame is the new baseline
          this.emit("subscribed", channels);
        }
        else this.emit("unsubscribed", channels);
        return;
      }
      case "signed_out": {
        // signed_out (a planned server frame): the server signed this connection out (token expired, session revoked, or a
        // future reason). Private subscriptions are gone; a fresh auth on this socket restores them.
        const raw = typeof frame["reason"] === "string" ? frame["reason"] : "";
        this.#token = null;
        if (raw === "revoked") {
          this.#signedOut("session_revoked");
          this.emit("authLost", {
            type: "session.revoked",
            channel: "account",
            data: { session_id: null, reason: "signed_out", current: true },
          });
        } else if (raw === "expired") {
          this.#signedOut("token_expired");
        } else {
          this.#signedOut("signed_out", raw);
        }
        return;
      }
      case "error": {
        const code = typeof frame["code"] === "string" ? frame["code"] : "UNKNOWN";
        const message = typeof frame["message"] === "string" ? frame["message"] : code;
        const f: ErrorFrame = { type: "error", code, message, id: typeof frame["id"] === "string" ? frame["id"] : null };
        const err = new CexyWebSocketError(code, message, true);
        const id = f.id ?? null;
        if (id !== null) {
          const pending = this.#pending.get(id);
          if (pending) {
            this.#pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(err);
            // Any error on an auth frame signs the connection out (an UNAUTHENTICATED error
            // on a subscribe is only a refused subscribe).
            if (pending.kind === "auth") this.#signedOut("auth_failed", f.code);
          }
        }
        this.emit("serverError", err, f);
        if (f.code === "CONCURRENT_MODIFICATION" && id === null) {
          // The server dropped messages: resynchronise every book and channel.
          this.emit("resync", "concurrent_modification");
          for (const b of this.#books.values()) void b.resync();
        }
        return;
      }
      default:
        break;
    }
    if (typeof type !== "string" || !KNOWN_EVENT_TYPES.has(type)) {
      this.#logger.debug?.(`ignoring unknown frame type ${String(type)}`);
      return;
    }
    const event = frame as unknown as WsEvent;
    if (PRIVATE_CHANNELS.has(event.channel) && typeof event.sequence === "number") this.#trackSeq(event.channel, event.sequence);
    // Only this connection's own session signs it out (the server checks current == true
    // exactly); current false, missing or not a boolean changes nothing.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- wire data may not match the type
    if (event.type === "session.revoked" && event.data?.current === true) this.#onAuthLost(event);
    if (event.type === "balances.resync" || event.type === "deposits.resync" || event.type === "withdrawals.resync") {
      this.emit("event", event);
      this.emit("resync", event.type === "balances.resync" ? "balances_resync" : event.type === "deposits.resync" ? "deposits_resync" : "withdrawals_resync");
      return;
    }
    if (event.type === "orderbook.update") {
      const symbol = event.channel.startsWith("orderbook:") ? event.channel.slice("orderbook:".length) : event.data?.symbol;
      if (symbol) this.#books.get(symbol)?.onUpdate(event);
    }
    this.emit("event", event);
  }

  /** This connection's own session was revoked: the server has signed it out. */
  #onAuthLost(event: SessionRevokedEvent): void {
    this.#token = null;
    this.#signedOut("session_revoked");
    this.emit("authLost", event);
  }

  /** Forgets the sequence baseline of `channel` (all channels when omitted). */
  #resetSeq(channel?: string): void {
    const states = channel === undefined ? [...this.#seq.values()] : [this.#seq.get(channel)].filter((x) => x !== undefined);
    for (const st of states) if (st.timer !== null) this.#clock.clearTimeout(st.timer);
    if (channel === undefined) this.#seq.clear();
    else this.#seq.delete(channel);
  }

  /**
   * Frame-sequence tracking for a private channel: the first frame is the baseline, a lower
   * number is late (never a gap), and a higher one opens holes that must fill within the
   * reorder window.
   */
  #trackSeq(channel: string, n: number): void {
    const st = this.#seq.get(channel);
    if (!st || st.next === null) {
      this.#seq.set(channel, { next: n + 1, holes: new Set(), first: null, timer: null });
      return;
    }
    if (n < st.next) {
      if (st.holes.delete(n) && st.holes.size === 0 && st.timer !== null) {
        this.#clock.clearTimeout(st.timer);
        st.timer = null;
        st.first = null;
      }
      return;
    }
    for (let m = st.next; m < n; m++) st.holes.add(m);
    if (n > st.next && st.first === null) st.first = { channel, expected: st.next, received: n };
    st.next = n + 1;
    if (st.holes.size > 0 && st.timer === null) {
      const state = st;
      state.timer = this.#clock.setTimeout(() => {
        state.timer = null;
        if (state.holes.size === 0 || this.#seq.get(channel) !== state) return;
        const gap = state.first ?? { channel, expected: Math.min(...state.holes), received: (state.next ?? 1) - 1 };
        state.holes.clear();
        state.first = null;
        this.emit("sequenceGap", gap);
        this.emit("resync", "sequence_gap");
      }, this.#reorderWindowMs);
    }
  }

  /** Moves the held private channels to the pending set; returns them. */
  #dropPrivate(): string[] {
    const dropped = [...this.#channels].filter((c) => PRIVATE_CHANNELS.has(c));
    for (const c of dropped) {
      this.#channels.delete(c);
      this.#pendingPrivate.add(c);
    }
    return dropped;
  }

  /** The server signed the connection out and dropped every private subscription. */
  #signedOut(reason: Exclude<AuthChangeReason, "user_changed">, code?: string): void {
    const previousUserId = this.#authUserId;
    this.#authUserId = null;
    for (const c of PRIVATE_CHANNELS) this.#resetSeq(c);
    const dropped = this.#dropPrivate();
    const change: AuthChange = { reason, previousUserId, userId: null, dropped };
    if (code !== undefined) change.code = code;
    this.emit("authChanged", change);
  }

  /** A successful auth: detect an account switch, then restore pending private channels. */
  #onAuthenticated(userId: string | null): void {
    const previousUserId = this.#authUserId;
    this.#authUserId = userId;
    if (previousUserId !== null && userId !== previousUserId) {
      for (const c of PRIVATE_CHANNELS) this.#resetSeq(c);
      const dropped = this.#dropPrivate();
      this.emit("authChanged", { reason: "user_changed", previousUserId, userId, dropped });
    }
    if (this.#pendingPrivate.size === 0) return;
    const channels = [...this.#pendingPrivate];
    this.#pendingPrivate.clear();
    for (const c of channels) this.#channels.add(c);
    this.#sendSubscribe(channels).catch((err: unknown) => {
      // Refused by the server (e.g. signed out again meanwhile): back to pending, not held.
      if (err instanceof CexyWebSocketError && err.fromServer) {
        for (const c of channels) if (this.#channels.delete(c)) this.#pendingPrivate.add(c);
      }
      this.#emitError(err);
    });
    this.emit("resync", "reauth");
  }

  /** Resolves the pending request `id` if the acknowledgement type matches its kind. */
  #settle(id: string, kind: RequestKind, frame: Record<string, unknown>): void {
    const p = this.#pending.get(id);
    if (!p || p.kind !== kind) return;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(frame);
  }

  /**
   * Sends `{op, id, ...payload}` and waits for the acknowledgement with the same id
   * (`ACK_TYPE[kind]`) or an `error` with that id. With `strict`, no acknowledgement within
   * `ackTimeoutMs` rejects; otherwise it resolves with null.
   */
  #request(kind: RequestKind, payload: Record<string, unknown>, channels: string[], strict: boolean): Promise<Record<string, unknown> | null> {
    const id = this.#newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        if (strict) reject(new CexyWebSocketError("TIMEOUT", `no ${ACK_TYPE[kind]} acknowledgement for ${kind} (id ${id})`));
        else resolve(null);
      }, this.#opts.ackTimeoutMs);
      this.#pending.set(id, { id, kind, channels, resolve, reject, timer });
      try {
        this.#send({ op: kind, ...payload, id });
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(toError(err));
      }
    });
  }

  async #auth(token: string): Promise<AuthResult> {
    try {
      const ack = await this.#request("auth", { token }, [], true);
      const userId = ack && typeof ack["user_id"] === "string" ? ack["user_id"] : null;
      return { userId, queued: false };
    } catch (err) {
      // The server refused this token: do not send it again on reconnect.
      if (err instanceof CexyWebSocketError && err.fromServer && this.#token === token) {
        this.#token = null;
      }
      throw err;
    }
  }

  /** Automatic (re-)authentication; failures surface as `error` events. */
  #reAuth(token: string): void {
    this.#auth(token).catch((err: unknown) => this.#emitError(err));
  }

  async #sendSubscribe(channels: string[]): Promise<string[]> {
    // `subscribed` is sent only when something was added: silence means nothing new.
    const ack = await this.#request("subscribe", { channels }, channels, false);
    const acked = ack?.["channels"];
    return Array.isArray(acked) ? acked.filter((c): c is string => typeof c === "string") : [];
  }

  #send(frame: Record<string, unknown>): void {
    const s = this.#socket;
    if (!s || s.readyState !== OPEN) throw new CexyWebSocketError("NOT_CONNECTED", "WebSocket is not connected");
    const now = Date.now();
    if (now - this.#windowStart >= 60_000) {
      this.#windowStart = now;
      this.#windowCount = 0;
    }
    // Pings are never refused locally: without them the server closes the connection.
    if (frame["op"] !== "ping" && this.#windowCount >= this.#opts.maxMessagesPerMinute) {
      throw new CexyWebSocketError(
        "LOCAL_RATE_LIMIT",
        `more than ${this.#opts.maxMessagesPerMinute} messages this minute; the server closes the socket above 240`,
      );
    }
    this.#windowCount++;
    s.send(JSON.stringify(frame));
  }

  #startHeartbeat(): void {
    this.#stopTimers();
    this.#pingTimer = setInterval(() => {
      try {
        this.#send({ op: "ping" });
      } catch {
        /* reconnect logic handles a dead socket */
      }
    }, this.#opts.pingIntervalMs);
    this.#touch();
  }

  #touch(): void {
    if (this.#livenessTimer) clearTimeout(this.#livenessTimer);
    this.#livenessTimer = setTimeout(() => {
      this.#logger.warn(`no frame from server for ${this.#opts.livenessTimeoutMs} ms; reconnecting`);
      const s = this.#socket;
      if (s) {
        this.#detach(s);
        try {
          const terminate = (s as { terminate?: () => void }).terminate;
          if (terminate) terminate.call(s);
          else s.close(4000, "liveness timeout");
        } catch {
          /* ignore */
        }
      }
      this.#onDropped(4000, "liveness timeout");
    }, this.#opts.livenessTimeoutMs);
  }

  #stopTimers(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    if (this.#livenessTimer) clearTimeout(this.#livenessTimer);
    this.#pingTimer = null;
    this.#livenessTimer = null;
  }

  #detach(s: WebSocketLike): void {
    s.onopen = null;
    s.onmessage = null;
    s.onclose = null;
    s.onerror = () => {};
  }

  #teardown(err: Error): void {
    this.#stopTimers();
    if (this.#socket) this.#detach(this.#socket);
    this.#socket = null;
    this.#welcome = null;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }

  #onDropped(code: number | undefined, reason: string | undefined): void {
    this.#teardown(new CexyWebSocketError("DISCONNECTED", `connection lost (code ${code ?? "?"})`));
    // Sequences reset per connection: books wait for a fresh snapshot.
    for (const b of this.#books.values()) b.markDisconnected();
    const willReconnect = !this.#closedByUser && this.#reconnect !== null;
    this.emit("close", { code, reason, willReconnect });
    if (willReconnect) this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    const rc = this.#reconnect;
    if (!rc || this.#closedByUser) return;
    if (this.#reconnectAttempt >= rc.maxAttempts) {
      this.emit("error", new CexyWebSocketError("RECONNECT_FAILED", `gave up after ${rc.maxAttempts} reconnect attempts`));
      return;
    }
    const attempt = ++this.#reconnectAttempt;
    const cap = Math.min(rc.maxDelayMs, rc.baseDelayMs * 2 ** (attempt - 1));
    const delayMs = Math.floor(this.#random() * cap); // full jitter
    this.emit("reconnecting", { attempt, delayMs });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#closedByUser) return;
      this.#open().catch((err: unknown) => {
        this.emit("error", toError(err));
        this.#scheduleReconnect();
      });
    }, delayMs);
  }

  /** Emits `error`, except for requests cut short by a disconnect (the reconnect redoes them). */
  #emitError(err: unknown): void {
    if (err instanceof CexyWebSocketError && TEARDOWN_CODES.has(err.code)) return;
    this.emit("error", toError(err));
  }

  #newId(): string {
    return String(this.#nextId++);
  }
}

function parseFrame(data: unknown): Record<string, unknown> | null {
  let text: string;
  if (typeof data === "string") text = data;
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
  else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data);
  else return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
