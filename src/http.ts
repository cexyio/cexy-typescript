import type { Authenticator } from "./auth.js";
import {
  CexyApiError,
  CexyConfigError,
  CexyConnectionError,
  CexyError,
  CexyTimeoutError,
  RateLimitError,
  errorFromResponse,
  retryAfterMs,
} from "./errors.js";
import type { RateLimiter } from "./limiter.js";
import { OPERATIONS, type OperationId, type OperationInfo } from "./operations.js";

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
   * Mutations only: the `Idempotency-Key` to send. Generated automatically when absent.
   * The server honours it on pool join/exit; set it yourself to make a retry across process
   * restarts safe there. Orders and cancels do NOT honour it: their safety comes from
   * `client_order_id` (see `placeOrder`).
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

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export class Transport {
  readonly config: TransportConfig;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  /**
   * Sends a request with the standard retry policy: GETs retry on retryable errors and
   * network failures. Mutations carry an `Idempotency-Key` reused on every attempt; the server
   * honours it on pool join/exit, which makes their retries safe. The other mutations routed
   * here (cancel-all) are naturally repeatable. `placeOrder` and `cancelOrder` use
   * `attempt()` with their own policies.
   */
  async request(spec: CallSpec, opts: RequestOptions = {}): Promise<RawResponse> {
    const info = OPERATIONS[spec.op];
    const isMutation = info.method !== "GET";
    const idempotencyKey = isMutation ? (spec.idempotencyKey ?? opts.idempotencyKey ?? newId()) : undefined;
    const maxRetries = opts.maxRetries ?? this.config.maxRetries;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt({ ...spec, idempotencyKey }, opts);
      } catch (err) {
        if (attempt >= maxRetries || !isRetryable(err) || opts.signal?.aborted) throw err;
        await this.backoff(spec.op, info, attempt, err, idempotencyKey, opts.signal);
      }
    }
  }

  /** Waits before retry number `attempt + 1`, honouring server hints. */
  async backoff(
    op: OperationId,
    info: OperationInfo,
    attempt: number,
    err: unknown,
    idempotencyKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
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
    const hint = err instanceof RateLimitError ? err.retryAfterMs : err instanceof CexyApiError ? retryAfterMs(undefined, err.details) : null;
    if (hint !== null && hint > 0) return Math.ceil(hint + this.config.random() * 250);
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return Math.ceil(this.config.random() * cap);
  }

  /** One attempt: rate limiter, credentials, timeout, error mapping. No retries. */
  async attempt(spec: CallSpec, opts: RequestOptions = {}): Promise<RawResponse> {
    const info = OPERATIONS[spec.op];
    const url = this.buildUrl(info, spec.pathParams, spec.query);
    const headers = new Headers({ Accept: spec.responseType === "text" ? "text/csv, application/json" : "application/json" });
    if (this.config.userAgent) headers.set("User-Agent", this.config.userAgent);
    let body: string | undefined;
    if (spec.body !== undefined) {
      body = JSON.stringify(spec.body);
      headers.set("Content-Type", "application/json");
    }
    if (info.method !== "GET" && spec.idempotencyKey) headers.set("Idempotency-Key", spec.idempotencyKey);

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
        code: "UNEXPECTED_REDIRECT",
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
      return encodeURIComponent(v);
    });
    const url = new URL(this.config.baseUrl.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      if (v instanceof Date) url.searchParams.set(k, v.toISOString());
      else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") url.searchParams.set(k, String(v));
      else throw new CexyConfigError(`${info.sdkMethod}(): query parameter ${k} must be a string, number, boolean or Date`);
    }
    return url;
  }

  redact(text: string): string {
    return this.config.authenticator ? this.config.authenticator.redact(text) : text;
  }
}

/** Retryable = a network failure/timeout, or an API error with `retryable: true` (incl. 409 CONCURRENT_MODIFICATION). */
export function isRetryable(err: unknown): boolean {
  if (err instanceof CexyConnectionError) return true;
  if (err instanceof CexyApiError) return err.retryable || err.code === "CONCURRENT_MODIFICATION";
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
