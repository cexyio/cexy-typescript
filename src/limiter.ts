/**
 * Client-side token bucket. `CexyClient` defaults to 100 requests/minute without credentials
 * and 300/minute with an API key (the server allows about 120/min per IP and 600/min per
 * key; this keeps a margin). It adapts to `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
 * `X-RateLimit-Reset` when the server sends them, and to 429 `Retry-After`.
 */
/** Longest block any server hint can impose on the limiter (mirrors `MAX_SERVER_WAIT_MS`). */
const MAX_BLOCK_MS = 120_000;

export interface RateLimiterOptions {
  requestsPerMinute: number;
  /** @internal for tests */
  now?: () => number;
  /** @internal for tests */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RateLimiterState {
  requestsPerMinute: number;
  tokens: number;
  blockedUntil: number;
}

export class RateLimiter {
  #rpm: number;
  #tokens: number;
  #last: number;
  #blockedUntil = 0;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(opts: RateLimiterOptions) {
    if (!(opts.requestsPerMinute > 0)) throw new RangeError("requestsPerMinute must be > 0");
    this.#rpm = opts.requestsPerMinute;
    this.#tokens = opts.requestsPerMinute;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? sleep;
    this.#last = this.#now();
  }

  get state(): RateLimiterState {
    this.#refill();
    return { requestsPerMinute: this.#rpm, tokens: this.#tokens, blockedUntil: this.#blockedUntil };
  }

  /** Waits until a request may be sent, then takes a token. */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      this.#refill();
      const now = this.#now();
      if (now < this.#blockedUntil) {
        await this.#sleep(this.#blockedUntil - now, signal);
        continue;
      }
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const msPerToken = 60_000 / this.#rpm;
      await this.#sleep(Math.min(MAX_BLOCK_MS, Math.ceil((1 - this.#tokens) * msPerToken)), signal);
    }
  }

  /** Adapts to the server's rate-limit headers. Never raises the configured limit. */
  update(headers: Headers): void {
    this.#refill();
    const limit = num(headers.get("x-ratelimit-limit"));
    // Below one request a minute a server limit is not credible; ignore it.
    if (limit !== null && limit >= 1 && limit < this.#rpm) {
      this.#rpm = limit;
      this.#tokens = Math.min(this.#tokens, limit);
    }
    const remaining = num(headers.get("x-ratelimit-remaining"));
    if (remaining !== null && remaining >= 0 && remaining < this.#tokens) this.#tokens = remaining;
    if (remaining === 0) {
      const reset = num(headers.get("x-ratelimit-reset"));
      if (reset !== null) this.blockFor(resetToMs(reset, this.#now()));
      else this.blockFor(60_000 / this.#rpm);
    }
  }

  /**
   * Blocks all requests for `ms` (used for 429 Retry-After and `X-RateLimit-Reset`). Server
   * hints are untrusted: non-finite values are ignored and the block is capped at 120 s.
   */
  blockFor(ms: number): void {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    this.#blockedUntil = Math.max(this.#blockedUntil, this.#now() + Math.min(ms, MAX_BLOCK_MS));
  }

  #refill(): void {
    const now = this.#now();
    const elapsed = now - this.#last;
    if (elapsed > 0) {
      this.#tokens = Math.min(this.#rpm, this.#tokens + (elapsed * this.#rpm) / 60_000);
      this.#last = now;
    }
  }
}

/**
 * `X-RateLimit-Reset` is the number of seconds until the window resets. Values that can only
 * be epoch timestamps (seconds or milliseconds) are tolerated. Returns milliseconds from now.
 */
function resetToMs(reset: number, now: number): number {
  if (reset > 1e12) return Math.max(0, reset - now);
  if (reset > 1e9) return Math.max(0, reset * 1000 - now);
  return Math.max(0, reset * 1000);
}

function num(v: string | null): number | null {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Abortable sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  const r: unknown = signal?.reason;
  return r instanceof Error ? r : new Error("aborted");
}
