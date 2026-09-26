import { TypedEmitter } from "./emitter.js";
import type { SnapshotSource } from "./client.js";
import type { BookLevel, OrderBookUpdateEvent } from "./types.js";

/** Levels the WebSocket book carries per side. REST levels deeper than this are never merged. */
export const WS_BOOK_DEPTH = 50;

export interface LiveOrderBookOptions {
  /** Retry delay after a failed snapshot. Default 1000 ms (doubles up to 30 s). */
  snapshotRetryMs?: number;
}

export interface LiveOrderBookEvents extends Record<string, unknown[]> {
  /** The book changed (snapshot applied or update applied). */
  update: [LiveOrderBook];
  /** A sequence gap: the book is stale until the next update heals it. */
  stale: [{ expected: number; received: number }];
  /** The update after a gap arrived in order; the book is current again. */
  healed: [];
  /** A fresh REST snapshot is being taken (reconnect, CONCURRENT_MODIFICATION, first sync). */
  resync: [];
  error: [Error];
}

/**
 * A local order book fed by `orderbook:{symbol}`. Created by `CexyWebSocket.orderBook()`.
 * Levels are `[price, quantity]` decimal strings, best first, at most 50 per side.
 */
export class LiveOrderBook extends TypedEmitter<LiveOrderBookEvents> {
  readonly symbol: string;
  bids: BookLevel[] = [];
  asks: BookLevel[] = [];
  /** Sequence of the last applied snapshot/update on the current connection. */
  sequence: number | null = null;
  /** True after a sequence gap, until the next in-order update. */
  stale = false;
  /** False while waiting for a snapshot (after connect, reconnect or resync). */
  synced = false;

  readonly #rest: SnapshotSource;
  readonly #onClose: () => void;
  readonly #retryMs: number;
  #buffer: OrderBookUpdateEvent[] = [];
  #generation = 0;
  #closed = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** @internal use `CexyWebSocket.orderBook()` */
  constructor(symbol: string, rest: SnapshotSource, options: LiveOrderBookOptions, onClose: () => void) {
    super();
    this.symbol = symbol;
    this.#rest = rest;
    this.#onClose = onClose;
    this.#retryMs = options.snapshotRetryMs ?? 1_000;
  }

  /** Best bid and ask (null when that side is empty). */
  get top(): { bid: BookLevel | null; ask: BookLevel | null } {
    return { bid: this.bids[0] ?? null, ask: this.asks[0] ?? null };
  }

  /** @internal The connection dropped: sequences from the next connection are unrelated. */
  markDisconnected(): void {
    this.#generation++;
    this.synced = false;
    this.sequence = null;
    this.#buffer = [];
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /**
   * Takes a fresh REST snapshot and replays buffered updates newer than it.
   * Called automatically; safe to call yourself.
   */
  async resync(attempt = 0): Promise<void> {
    if (this.#closed) return;
    const gen = ++this.#generation;
    this.synced = false;
    this.sequence = null;
    // Keep anything already buffered: updates newer than the snapshot are replayed.
    this.emit("resync");
    try {
      const snap = await this.#rest.markets.orderbook(this.symbol, { depth: WS_BOOK_DEPTH });
      if (gen !== this.#generation || this.#closed) return; // superseded
      this.bids = snap.bids.slice(0, WS_BOOK_DEPTH) as BookLevel[];
      this.asks = snap.asks.slice(0, WS_BOOK_DEPTH) as BookLevel[];
      this.sequence = snap.sequence;
      this.stale = false;
      this.synced = true;
      const buffered = this.#buffer;
      this.#buffer = [];
      this.emit("update", this);
      for (const u of buffered) this.#apply(u);
    } catch (err) {
      if (gen !== this.#generation || this.#closed) return;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      const delay = Math.min(30_000, this.#retryMs * 2 ** attempt);
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        if (gen === this.#generation) void this.resync(attempt + 1);
      }, delay);
    }
  }

  /** @internal */
  onUpdate(event: OrderBookUpdateEvent): void {
    if (this.#closed) return;
    if (!this.synced) {
      this.#buffer.push(event);
      return;
    }
    this.#apply(event);
  }

  /** Stops following the book and unsubscribes. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation++;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#onClose();
    this.removeAllListeners();
  }

  #apply(event: OrderBookUpdateEvent): void {
    const seq = event.sequence;
    if (typeof seq === "number" && this.sequence !== null) {
      if (seq <= this.sequence) return; // already covered by the snapshot / applied
      if (seq !== this.sequence + 1) {
        this.stale = true;
        this.emit("stale", { expected: this.sequence + 1, received: seq });
      } else if (this.stale) {
        this.stale = false;
        this.emit("healed");
      }
    }
    // Each update is the complete top 50 of both sides (`full: true`): replace, never merge.
    this.bids = (event.data.bids ?? []).slice(0, WS_BOOK_DEPTH);
    this.asks = (event.data.asks ?? []).slice(0, WS_BOOK_DEPTH);
    if (typeof seq === "number") this.sequence = seq;
    this.emit("update", this);
  }
}
