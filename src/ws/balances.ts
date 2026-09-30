import { TypedEmitter } from "./emitter.js";
import type { Balance } from "../types.js";
import type { BalanceUpdatedEvent, WsEvent } from "./types.js";
import type { AuthChange, CexyWebSocket, ResyncReason, SequenceGap, WsClock } from "./client.js";

export interface LiveBalancesOptions {
  /**
   * Where snapshots come from. Default: `restClient.account.balances()` of `CexyClient.websocket()`.
   * It must return the balances of the same account the WebSocket is authenticated as.
   */
  snapshot?: () => Promise<Balance[]>;
  /**
   * The user id the snapshot source belongs to, compared with the WebSocket's authenticated
   * user at the start and after every account change. Default: `restClient.account.id()` (GET /api/v1/account/id).
   */
  ownerId?: () => Promise<string>;
  /** A fixed owner user id instead of `ownerId`. */
  accountId?: string;
  /** Minimum time between successful snapshots (the API key's rate limit is shared). Default 2000 ms. */
  minSnapshotIntervalMs?: number;
  /** Retry delay after a failed snapshot or owner lookup. Default 1000 ms (doubles up to 30 s). */
  retryMs?: number;
}

/** Why a snapshot was taken. */
export type LiveBalancesSnapshotReason = "start" | ResyncReason | "resubscribed" | "retry";

export interface LiveBalancesEvents extends Record<string, unknown[]> {
  /** One asset changed (`null`: the row was removed because its total reached 0). */
  update: [asset: string, balance: Balance | null];
  /** A snapshot was applied. */
  snapshot: [reason: LiveBalancesSnapshotReason];
  /**
   * `ACCOUNT_MISMATCH` (the snapshot source belongs to another user: nothing is merged),
   * or a failed snapshot or owner lookup (retried with backoff).
   */
  error: [Error & { code?: string }];
}

/** The snapshot source belongs to another account than the WebSocket session. */
export class AccountMismatchError extends Error {
  readonly code = "ACCOUNT_MISMATCH";
  constructor(
    readonly websocketUserId: string,
    readonly snapshotUserId: string,
  ) {
    super(`live balances: the snapshot source belongs to ${snapshotUserId}, the WebSocket to ${websocketUserId}; not merging`);
    this.name = "AccountMismatchError";
  }
}

const ZERO = /^[+-]?0*(\.0*)?$/;

/**
 * Live balances of the authenticated account, fed by the `balances` channel and REST snapshots.
 * Created by `CexyWebSocket.liveBalances()` after `auth()`.
 *
 * Rules: an event applies only if its `data.sequence` is greater than the stored one for that
 * asset; a total of 0 removes the row (a snapshot row at or below that sequence cannot bring it
 * back). A new snapshot is taken on a frame gap, `balances.resync`, `CONCURRENT_MODIFICATION`, a
 * reconnect and after an account change, never because `data.sequence` skipped values. At
 * the start and after every account change the snapshot source's owner is checked against the WebSocket user.
 */
export class LiveBalances extends TypedEmitter<LiveBalancesEvents> {
  /** True until the first snapshot, and from every refetch trigger until the next snapshot is applied. */
  stale = true;
  /**
   * The last error (also emitted as `error`; the first check can fail before a listener is
   * attached). `code === "ACCOUNT_MISMATCH"`: nothing was merged. Cleared by the next snapshot.
   */
  lastError: (Error & { code?: string }) | null = null;

  readonly #ws: CexyWebSocket;
  readonly #clock: WsClock;
  readonly #snapshot: () => Promise<Balance[]>;
  readonly #ownerId: () => Promise<string>;
  readonly #minIntervalMs: number;
  readonly #retryMs: number;
  #rows = new Map<string, Balance>();
  #tombstones = new Map<string, number>();
  #buffer: BalanceUpdatedEvent["data"][] = [];
  #verifiedUser: string | null = null;
  #fetching = false;
  #again: LiveBalancesSnapshotReason | null = null;
  #lastSuccess: number | null = null;
  #timer: unknown = null;
  #attempt = 0;
  #closed = false;
  #generation = 0;
  #warnedNoSequence = false;
  readonly #off: (() => void)[] = [];

  /** @internal use `CexyWebSocket.liveBalances()` */
  constructor(
    ws: CexyWebSocket,
    options: { snapshot: () => Promise<Balance[]>; ownerId: () => Promise<string> } & LiveBalancesOptions,
  ) {
    super();
    this.#ws = ws;
    this.#clock = ws.clock;
    this.#snapshot = options.snapshot;
    this.#ownerId = options.ownerId;
    this.#minIntervalMs = options.minSnapshotIntervalMs ?? 2_000;
    this.#retryMs = options.retryMs ?? 1_000;
    this.#off.push(
      ws.on("event", (ev: WsEvent) => {
        if (ev.type === "balance.updated") this.#onEvent(ev.data);
      }),
      ws.on("sequenceGap", (g: SequenceGap) => {
        if (g.channel === "balances") this.#trigger("sequence_gap");
      }),
      ws.on("resync", (reason: ResyncReason) => {
        if (reason === "balances_resync" || reason === "concurrent_modification") this.#trigger(reason);
      }),
      ws.on("authChanged", (change: AuthChange) => this.#onAuthChanged(change)),
      ws.on("subscribed", (channels: string[]) => {
        if (channels.includes("balances")) this.#trigger("resubscribed");
      }),
      ws.on("close", () => this.#markStale()),
    );
  }

  /** @internal events held for the snapshot in flight (tests) */
  get bufferedEvents(): number {
    return this.#buffer.length;
  }

  /** A copy of one asset's balance, or null. */
  get(asset: string): Balance | null {
    const b = this.#rows.get(asset);
    return b ? { ...b } : null;
  }

  /** Copies of every non-zero balance. */
  all(): Balance[] {
    return [...this.#rows.values()].map((b) => ({ ...b }));
  }

  /** Stops following (unsubscribes `balances` unless something else on this socket needs it). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelTimer();
    for (const off of this.#off.splice(0)) off();
    this.#ws.releaseBalances(this);
  }

  /** @internal first snapshot after the `subscribed` reply (or when `balances` was already held) */
  start(): void {
    this.#trigger("start");
  }

  #markStale(): void {
    this.stale = true;
    this.#generation++;
    this.#buffer = [];
  }

  #onAuthChanged(change: AuthChange): void {
    this.#verifiedUser = null;
    this.#markStale();
    if (change.reason === "user_changed") {
      // Another account's balances must never show: forget everything until the owner check.
      this.#rows.clear();
      this.#tombstones.clear();
    }
  }

  #trigger(reason: LiveBalancesSnapshotReason): void {
    if (this.#closed) return;
    this.stale = true;
    if (this.#fetching) {
      this.#again ??= reason;
      return;
    }
    if (this.#timer !== null) return; // already scheduled
    const wait = this.#lastSuccess === null ? 0 : this.#lastSuccess + this.#minIntervalMs - this.#clock.now();
    if (wait > 0) {
      this.#timer = this.#clock.setTimeout(() => {
        this.#timer = null;
        void this.#fetch(reason);
      }, wait);
      return;
    }
    void this.#fetch(reason);
  }

  #cancelTimer(): void {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #fetch(reason: LiveBalancesSnapshotReason): Promise<void> {
    if (this.#closed) return;
    const wsUser = this.#ws.userId;
    if (wsUser === null) return; // signed out: the re-subscribe after the next auth triggers again
    this.#fetching = true;
    this.#buffer = [];
    const gen = ++this.#generation;
    try {
      if (this.#verifiedUser !== wsUser) {
        const owner = await this.#ownerId();
        if (this.#closed || gen !== this.#generation) return this.#done();
        if (owner !== this.#ws.userId || owner !== wsUser) {
          this.#rows.clear();
          this.#tombstones.clear();
          this.#buffer = []; // events that arrived during the owner lookup
          this.#fetching = false;
          this.#again = null;
          this.lastError = new AccountMismatchError(wsUser, owner);
          this.emit("error", this.lastError);
          return;
        }
        this.#verifiedUser = wsUser;
      }
      const rows = await this.#snapshot();
      if (this.#closed || gen !== this.#generation) return this.#done();
      this.#applySnapshot(rows);
      this.#attempt = 0;
      this.#lastSuccess = this.#clock.now();
      this.stale = false;
      this.lastError = null;
      this.#fetching = false;
      this.emit("snapshot", reason);
      const again = this.#again;
      this.#again = null;
      if (again !== null) this.#trigger(again);
    } catch (err) {
      this.#fetching = false;
      if (this.#closed) return;
      this.lastError = err instanceof Error ? err : new Error(String(err));
      this.emit("error", this.lastError);
      const delay = Math.min(30_000, this.#retryMs * 2 ** this.#attempt++);
      this.#cancelTimer();
      this.#timer = this.#clock.setTimeout(() => {
        this.#timer = null;
        this.#trigger("retry");
      }, delay);
    }
  }

  /** A fetch overtaken by a stale mark (account change, disconnect): start over if needed. */
  #done(): void {
    this.#fetching = false;
    const again = this.#again;
    this.#again = null;
    if (again !== null && !this.#closed) this.#trigger(again);
  }

  #applySnapshot(rows: Balance[]): void {
    const next = new Map<string, Balance>();
    for (const r of rows) {
      const tomb = this.#tombstones.get(r.asset);
      if (tomb !== undefined) {
        if (r.sequence <= tomb) continue;
        this.#tombstones.delete(r.asset);
      }
      if (ZERO.test(r.total)) continue;
      next.set(r.asset, { ...r, held_incoming: Array.isArray(r.held_incoming) ? r.held_incoming : [] });
    }
    this.#rows = next;
    const buffered = this.#buffer;
    this.#buffer = [];
    for (const d of buffered) this.#apply(d, false);
  }

  #onEvent(d: BalanceUpdatedEvent["data"]): void {
    if (this.#closed || !d || typeof d.asset !== "string") return;
    // Buffered only while a snapshot is in flight (it is applied on top). Without a verified
    // owner and no fetch (mismatch, retry backoff, signed out), events are dropped: the next
    // snapshot is complete anyway.
    if (this.#fetching) {
      this.#buffer.push(d);
      return;
    }
    if (this.#verifiedUser === null) return;
    this.#apply(d, true);
  }

  #apply(d: BalanceUpdatedEvent["data"], emit: boolean): void {
    const prev = this.#rows.get(d.asset);
    const current = prev?.sequence ?? this.#tombstones.get(d.asset) ?? -1;
    // A server that predates live balances sends no data.sequence: such an event always applies
    // and keeps the stored sequence (a later sequenced snapshot or event takes over).
    const sequenced = typeof d.sequence === "number";
    if (!sequenced && !this.#warnedNoSequence) {
      this.#warnedNoSequence = true;
      this.#ws.logger.warn("live balances: the server sends balance.updated without data.sequence; applying every event in arrival order");
    }
    const seq = sequenced ? d.sequence : Math.max(current, prev?.sequence ?? 0);
    if (sequenced && d.sequence <= current) return; // duplicate or older
    if (ZERO.test(d.total)) {
      this.#rows.delete(d.asset);
      if (sequenced) this.#tombstones.set(d.asset, d.sequence);
      if (emit) this.emit("update", d.asset, null);
      return;
    }
    const row: Balance = {
      held_incoming: prev?.held_incoming ?? [],
      ...prev,
      asset: d.asset,
      available: d.available,
      locked: d.locked,
      pending: d.pending,
      total: d.total,
      sequence: seq < 0 ? 0 : seq,
    };
    this.#rows.set(d.asset, row);
    this.#tombstones.delete(d.asset);
    if (emit) this.emit("update", d.asset, { ...row });
  }
}
