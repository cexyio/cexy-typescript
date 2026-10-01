import type { Authenticator } from "./auth.js";
import { HmacAuthenticator, encodeComponent } from "./signing.js";
import {
  CexyApiError,
  CLIENT_ERROR_CODES,
  CexyConfigError,
  CexyConnectionError,
  CexyError,
  CexyTimeoutError,
  MAX_SERVER_WAIT_MS,
  RateLimitError,
  errorFromResponse,
} from "./errors.js";
import type { RateLimiter } from "./limiter.js";
import { OPERATIONS, type OperationId, type OperationInfo } from "./operations.js";
import { stripTrailingSlashes } from "./url.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Per-call options accepted by every facade method as its last argument. */
export interface RequestOptions {
  /** Abort the call (including retries and waits). */
  signal?: AbortSignal;
  /** Overrides the client's `timeoutMs` for each attempt. */
  timeoutMs?: number;
  /** Overrides the client's `maxRetries`. */
  maxRetries?: number;
  /**
   * Pool join/exit only: the `Idempotency-Key` to send (generated automatically when absent,
   * and reused on every retry). The server honours it there; set it yourself to make a retry
   * across process restarts safe. No other request sends the header: orders and cancels do
   * not honour it, and their safety comes from `client_order_id` (see `placeOrder`).
   */
  idempotencyKey?: string;
}

/** Passed to the `onRetry` hook before the SDK waits and retries. */
export interface RetryInfo {
  operation: OperationId;
  method: string;
  path: string;
  /** 1 for the first retry. */
  attempt: number;
  delayMs: number;
  error: unknown;
  idempotencyKey: string | undefined;
}

export interface TransportConfig {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  fetch: FetchLike;
  authenticator: Authenticator | null;
  limiter: RateLimiter | null;
  userAgent: string | null;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  /** Milliseconds clock (default `Date.now`); injectable for tests. */
  now?: () => number;
  onRetry?: ((info: RetryInfo) => void) | undefined;
}

export interface CallSpec {
  op: OperationId;
  pathParams?: Record<string, string>;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  responseType?: "json" | "text";
  idempotencyKey?: string | undefined;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  data: unknown;
}

/** Operations on which the server honours `Idempotency-Key`: the only ones that send it. */
const IDEMPOTENT_OPS: ReadonlySet<OperationId> = new Set<OperationId>(["join_pool", "exit_pool"]);

/**
 * Mutations `request()` may retry: pool join/exit (the server honours their `Idempotency-Key`)
 * and cancel-all (naturally repeatable). Any other mutation sent through `request()` is never
 * retried; `placeOrder` and `cancelOrder` have their own policies on top of `attempt()`.
 */
const REPEAT_SAFE_MUTATIONS: ReadonlySet<OperationId> = new Set<OperationId>(["join_pool", "exit_pool", "cancel_all"]);

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export class Transport {
  readonly config: TransportConfig;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  /**
   * Sends a request with the standard retry policy: retryable errors and network failures are
   * retried. Pool join/exit carry an `Idempotency-Key` reused on every attempt (the server
   * honours it there, which makes their retries safe); the other mutations routed here
   * (cancel-all) are naturally repeatable and send no key. Any other mutation is sent once.
   * `placeOrder` and `cancelOrder` use `attempt()` with their own policies.
   */
  async request(spec: CallSpec, opts: RequestOptions = {}): Promise<RawResponse> {
    const info = OPERATIONS[spec.op];
    const idempotencyKey = IDEMPOTENT_OPS.has(spec.op) ? (spec.idempotencyKey ?? opts.idempotencyKey ?? newId()) : undefined;
    const repeatSafe = info.method === "GET" || REPEAT_SAFE_MUTATIONS.has(spec.op);
    const maxRetries = repeatSafe ? (opts.maxRetries ?? this.config.maxRetries) : 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt({ ...spec, idempotencyKey }, opts);
      } catch (err) {
        if (attempt >= maxRetries || !isRetryable(err) || opts.signal?.aborted) throw err;
        await this.backoff(spec.op, info, attempt, err, idempotencyKey, opts.signal);
      }
    }
  }

  /**
   * Waits before retry number `attempt + 1`, honouring server hints. A server hint longer than
   * `MAX_SERVER_WAIT_MS` is not waited: `err` is thrown at once (it still carries the hint).
   */
  async backoff(
    op: OperationId,
    info: OperationInfo,
    attempt: number,
    err: unknown,
    idempotencyKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const hint = serverHintMs(err);
    if (hint !== null && hint > MAX_SERVER_WAIT_MS) throw err;
    const delayMs = this.retryDelay(attempt, err);
    this.config.onRetry?.({
      operation: op,
      method: info.method,
      path: info.path,
      attempt: attempt + 1,
      delayMs,
      error: err,
      idempotencyKey,
    });
    await this.config.sleep(delayMs, signal);
  }

  /** Full-jitter exponential backoff, or the server's hint plus a little jitter. */
  retryDelay(attempt: number, err: unknown): number {
    const hint = serverHintMs(err);
    if (hint !== null && hint > 0 && hint <= MAX_SERVER_WAIT_MS) return Math.ceil(hint + this.config.random() * 250);
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return Math.ceil(this.config.random() * cap);
  }

  /**
   * One attempt: rate limiter, credentials, timeout, error mapping. No retries, except ONE
   * re-signed resend after `SIGNATURE_EXPIRED` once the client clock has been corrected.
   */
  async attempt(spec: CallSpec, opts: RequestOptions = {}): Promise<RawResponse> {
    try {
      return await this.#attemptOnce(spec, opts);
    } catch (err) {
      if (!(err instanceof CexyApiError)) throw err;
      const auth = this.config.authenticator;
      if (err.code === "SIGNATURE_REQUIRED") {
        throw new CexyApiError({
          status: err.status,
          code: err.code,
          message: 'this API key must sign its requests: use auth: "hmac" (the default) instead of "headers"',
          details: err.details,
          requestId: err.requestId,
          retryable: false,
        });
      }
      if (err.code === "KEY_NOT_SIGNABLE") {
        throw new CexyApiError({
          status: err.status,
          code: err.code,
          message: "create a new API key; keys issued before request signing can't sign",
          details: err.details,
          requestId: err.requestId,
          retryable: false,
        });
      }
      if (err.code !== "SIGNATURE_EXPIRED" || !(auth instanceof HmacAuthenticator)) throw err;
      const serverMs = Number(err.details["server_time_ms"]);
      if (!Number.isFinite(serverMs) || !auth.adjustClock(serverMs)) {
        throw new CexyApiError({
          status: err.status,
          code: err.code,
          message: "the local clock is more than 1 hour away from the server's: fix the system clock",
          details: err.details,
          requestId: err.requestId,
          retryable: false,
        });
      }
      return await this.#attemptOnce(spec, opts); // re-signed with the corrected clock, once
    }
  }

  async #attemptOnce(spec: CallSpec, opts: RequestOptions = {}): Promise<RawResponse> {
    const info = OPERATIONS[spec.op];
    const url = this.buildUrl(info, spec.pathParams, spec.query);
    const headers = new Headers({ Accept: spec.responseType === "text" ? "text/csv, application/json" : "application/json" });
    if (this.config.userAgent) headers.set("User-Agent", this.config.userAgent);
    let body: string | undefined;
    if (spec.body !== undefined) {
      body = JSON.stringify(spec.body);
      headers.set("Content-Type", "application/json");
    }
    if (IDEMPOTENT_OPS.has(spec.op) && spec.idempotencyKey) headers.set("Idempotency-Key", spec.idempotencyKey);

    if (info.auth === "api_key") {
      const auth = this.config.authenticator;
      if (!auth) {
        throw new CexyConfigError(
          `${info.sdkMethod}() needs an API key: construct the client with { apiKey, apiSecret }`,
        );
      }
      await auth.authenticate({ method: info.method, url, headers, body });
    }

    if (this.config.limiter) await this.config.limiter.acquire(opts.signal);

    const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let res: Response;
    let text: string;
    try {
      // Never follow redirects: fetch would re-send X-API-Key/X-API-Secret to the redirect target
      // (only Authorization is stripped cross-origin, and Node follows https -> http), and a
      // 307/308 would re-POST an order. A 3xx is surfaced as an error below instead.
      res = await this.config.fetch(url.toString(), {
        method: info.method,
        headers,
        body,
        signal: ctrl.signal,
        redirect: "manual",
      });
      text = await res.text();
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      if (timedOut) throw new CexyTimeoutError(`${info.method} ${info.path} timed out after ${timeoutMs} ms`);
      throw new CexyConnectionError(this.redact(`${info.method} ${info.path} failed: ${errMessage(err)}`), {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    // "opaqueredirect" is what browsers return for redirect: "manual"; Node returns the 3xx itself.
    // `redirected` catches a caller-supplied fetch that followed the redirect anyway.
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400) || res.redirected) {
      throw new CexyApiError({
        status: res.status,
        code: CLIENT_ERROR_CODES.UNEXPECTED_REDIRECT,
        message: `${info.method} ${info.path}: the server answered with a redirect (HTTP ${res.status}); the SDK does not follow redirects. Check baseUrl.`,
        retryable: false,
      });
    }

    this.config.limiter?.update(res.headers);

    if (!res.ok) {
      const parsed = safeJson(text);
      const error = errorFromResponse(res.status, parsed, res.headers, (t) => this.redact(t));
      if (error instanceof RateLimitError && error.retryAfterMs) this.config.limiter?.blockFor(error.retryAfterMs);
      throw error;
    }

    if (spec.responseType === "text") return { status: res.status, headers: res.headers, data: text };
    if (text === "") return { status: res.status, headers: res.headers, data: null };
    const data = safeJson(text);
    if (data === undefined) {
      throw new CexyError(`${info.method} ${info.path}: expected JSON, got ${res.headers.get("content-type") ?? "unknown content"}`);
    }
    return { status: res.status, headers: res.headers, data };
  }

  buildUrl(info: OperationInfo, pathParams: Record<string, string> = {}, query?: Record<string, unknown>): URL {
    const path = info.path.replace(/\{(\w+)\}/g, (_m, name: string) => {
      const v = pathParams[name];
      if (typeof v !== "string" || v === "") throw new CexyConfigError(`${info.sdkMethod}(): ${name} is required`);
      // "." and ".." would be dot segments: the URL layer resolves them (even as %2E), so the
      // request would silently go to a different route.
      if (v === "." || v === "..") throw new CexyConfigError(`${info.sdkMethod}(): ${name} must not be "." or ".."`);
      return encodeComponent(v);
    });
    const url = new URL(stripTrailingSlashes(this.config.baseUrl) + path);
    // Built here (RFC 3986: %20 for a space, %2B for a plus), not with URLSearchParams (which
    // writes "+" for a space), so the query that is signed is exactly the query that is sent.
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      let s: string;
      if (v instanceof Date) s = v.toISOString();
      else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") s = String(v);
      else throw new CexyConfigError(`${info.sdkMethod}(): query parameter ${k} must be a string, number, boolean or Date`);
      parts.push(`${encodeComponent(k)}=${encodeComponent(s)}`);
    }
    url.search = parts.length ? `?${parts.join("&")}` : "";
    return url;
  }

  redact(text: string): string {
    return this.config.authenticator ? this.config.authenticator.redact(text) : text;
  }
}

/** The server's wait hint on an error, in ms (null when it gave none or none is usable). */
export function serverHintMs(err: unknown): number | null {
  if (err instanceof CexyApiError) return err.retryAfterMs; // Retry-After on any status, not only 429
  return null;
}

/**
 * Retryable = a network failure/timeout, or an API error with `retryable: true` (incl. 409
 * CONCURRENT_MODIFICATION). A 4xx is never retryable except 429 and 409 CONCURRENT_MODIFICATION,
 * whatever its body says.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof CexyConnectionError) return true;
  if (err instanceof CexyApiError) {
    const concurrent = err.code === "CONCURRENT_MODIFICATION";
    if (err.status >= 400 && err.status < 500 && err.status !== 429 && !(err.status === 409 && concurrent)) return false;
    return err.retryable || concurrent;
  }
  return false;
}

/** True if a failure leaves it unknown whether a mutation took effect. */
export function isAmbiguous(err: unknown): boolean {
  if (err instanceof CexyConnectionError) return true;
  return err instanceof CexyApiError && err.status >= 500;
}

export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  throw new CexyConfigError("crypto.randomUUID is unavailable; pass an explicit id");
}

function safeJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
