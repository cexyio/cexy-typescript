import { ApiKeyAuthenticator, type Authenticator } from "./auth.js";
import { CexyConfigError } from "./errors.js";
import { assertSecureUrl } from "./url.js";
import { Transport, type FetchLike, type RequestOptions, type RetryInfo } from "./http.js";
import { RateLimiter, sleep as defaultSleep } from "./limiter.js";
import {
  AccountResource,
  AssetsResource,
  ExportsResource,
  FeesResource,
  MarketsResource,
  NetworksResource,
  PoolsResource,
  TradingResource,
  WalletResource,
} from "./resources.js";
import type { ExchangeConfig, ServerTime } from "./types.js";
import { USER_AGENT } from "./version.js";
import { CexyWebSocket, type CexyWebSocketOptions } from "./ws/client.js";

export const DEFAULT_BASE_URL = "https://api.cexy.io";
/** Default client-side limit without credentials (server: about 120/min per IP). */
export const DEFAULT_RPM_ANONYMOUS = 100;
/** Default client-side limit with an API key (server: about 600/min per key). */
export const DEFAULT_RPM_WITH_KEY = 300;

export interface CexyClientOptions {
  /** API key id (`ak_…`). Must be given together with `apiSecret`, or not at all. */
  apiKey?: string;
  /** API key secret. Never logged, never put in a URL. */
  apiSecret?: string;
  /**
   * Custom credentials scheme (for example HMAC signing once the API supports it).
   * Mutually exclusive with `apiKey`/`apiSecret`.
   */
  authenticator?: Authenticator;
  /** Default `https://api.cexy.io`. Must be `https://` (see `allowInsecure`). */
  baseUrl?: string;
  /**
   * Allow plain `http://` (and `ws://` for `websocket()`), but ONLY for a local host
   * (`localhost`, `127.0.0.1`, `::1`), e.g. a local mock server in tests. Default false.
   */
  allowInsecure?: boolean;
  /** Per-attempt timeout. Default 10000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt for retryable failures. Default 3. */
  maxRetries?: number;
  /**
   * A `fetch` implementation. Default: the global `fetch` (Node 22+, browsers).
   * It must honour `redirect: "manual"` (the SDK never follows redirects). A fetch that follows
   * them anyway has already sent the credentials to the redirect target by the time the SDK sees
   * `response.redirected` and throws `UNEXPECTED_REDIRECT`.
   */
  fetch?: FetchLike;
  /**
   * Client-side rate limit in requests per minute, or `false` to disable. Default 100/min
   * without credentials (the server allows about 120/min per IP for anonymous calls) and
   * 300/min with an API key (the server allows about 600/min per key). It adapts downwards
   * to the server's `X-RateLimit-Limit`/`-Remaining`/`-Reset` headers.
   */
  rateLimit?: { requestsPerMinute: number } | false;
  /**
   * Appended to the User-Agent, e.g. `"my-bot/1.2"` gives `cexy-typescript/0.1.0 my-bot/1.2`.
   * Browsers do not let scripts set User-Agent; there it is not sent.
   */
  userAgentSuffix?: string;
  /** Called before each retry (for logging/metrics). Never receives credentials. */
  onRetry?: (info: RetryInfo) => void;
  /** @internal Replace timers in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** @internal Deterministic jitter in tests. */
  random?: () => number;
  /** @internal Replace the clock in tests (milliseconds). */
  now?: () => number;
}

/**
 * CEXY.io REST client.
 *
 * ```ts
 * const cexy = new CexyClient();                        // public data only
 * const me = new CexyClient({ apiKey, apiSecret });     // + account, wallet reads, trading
 * ```
 */
export class CexyClient {
  readonly markets: MarketsResource;
  readonly assets: AssetsResource;
  readonly networks: NetworksResource;
  readonly fees: FeesResource;
  readonly pools: PoolsResource;
  readonly account: AccountResource;
  readonly exports: ExportsResource;
  readonly wallet: WalletResource;
  readonly trading: TradingResource;

  readonly #transport: Transport;
  readonly #baseUrl: string;
  readonly #allowInsecure: boolean;

  constructor(options: CexyClientOptions = {}) {
    const { apiKey, apiSecret } = options;
    const hasKey = apiKey !== undefined && apiKey !== null && apiKey !== "";
    const hasSecret = apiSecret !== undefined && apiSecret !== null && apiSecret !== "";
    if (hasKey !== hasSecret) {
      throw new CexyConfigError("apiKey and apiSecret must be given together (got only one of them)");
    }
    if (hasKey && options.authenticator) {
      throw new CexyConfigError("pass either apiKey/apiSecret or authenticator, not both");
    }
    const authenticator = options.authenticator ?? (hasKey ? new ApiKeyAuthenticator(apiKey, apiSecret as string) : null);

    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new CexyConfigError(`baseUrl is not a valid URL: ${baseUrl}`);
    }
    if (parsed.username || parsed.password || parsed.search) {
      throw new CexyConfigError("baseUrl must not contain credentials or a query string");
    }
    assertSecureUrl(parsed, "https:", "http:", options.allowInsecure === true, "baseUrl");
    this.#allowInsecure = options.allowInsecure === true;

    const fetchImpl = options.fetch ?? (globalThis.fetch);
    if (!fetchImpl) throw new CexyConfigError("no global fetch found (Node 22+ required); pass options.fetch");

    const timeoutMs = options.timeoutMs ?? 10_000;
    const maxRetries = options.maxRetries ?? 3;
    if (!(timeoutMs > 0)) throw new CexyConfigError("timeoutMs must be > 0");
    if (!(maxRetries >= 0)) throw new CexyConfigError("maxRetries must be >= 0");

    const sleep = options.sleep ?? defaultSleep;
    const limiter =
      options.rateLimit === false
        ? null
        : new RateLimiter({
            requestsPerMinute:
              options.rateLimit?.requestsPerMinute ?? (authenticator ? DEFAULT_RPM_WITH_KEY : DEFAULT_RPM_ANONYMOUS),
            sleep,
          });

    this.#baseUrl = baseUrl;
    this.#transport = new Transport({
      baseUrl,
      timeoutMs,
      maxRetries,
      fetch: options.fetch ? fetchImpl : (input, init) => fetchImpl(input, init),
      authenticator,
      limiter,
      userAgent: canSetUserAgent() ? [USER_AGENT, options.userAgentSuffix].filter(Boolean).join(" ") : null,
      sleep,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
      onRetry: options.onRetry,
    });

    const t = this.#transport;
    this.markets = new MarketsResource(t);
    this.assets = new AssetsResource(t);
    this.networks = new NetworksResource(t);
    this.fees = new FeesResource(t);
    this.pools = new PoolsResource(t);
    this.account = new AccountResource(t);
    this.exports = new ExportsResource(t);
    this.wallet = new WalletResource(t);
    this.trading = new TradingResource(t);
  }

  /** True if the client holds credentials (private endpoints are available). */
  get hasCredentials(): boolean {
    return this.#transport.config.authenticator !== null;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** Current client-side rate limit state, or null when disabled. */
  get rateLimit(): { requestsPerMinute: number; tokens: number; blockedUntil: number } | null {
    return this.#transport.config.limiter?.state ?? null;
  }

  /** The User-Agent this client sends (null in browsers). */
  get userAgent(): string | null {
    return this.#transport.config.userAgent;
  }

  /** Server clock. Compare it with yours to detect skew. */
  async time(opts?: RequestOptions): Promise<ServerTime> {
    const raw = await this.#transport.request({ op: "server_time" }, opts);
    return (raw.data as { data: ServerTime }).data;
  }

  /** Public exchange configuration (maintenance state, page sizes, WebSocket path, ...). */
  async config(opts?: RequestOptions): Promise<ExchangeConfig> {
    const raw = await this.#transport.request({ op: "exchange_config" }, opts);
    return (raw.data as { data: ExchangeConfig }).data;
  }

  /**
   * A WebSocket client for the same deployment, wired to this client for order-book
   * snapshots. Call `connect()` on it.
   */
  websocket(options: Omit<CexyWebSocketOptions, "restClient"> = {}): CexyWebSocket {
    const url = options.url ?? this.#baseUrl.replace(/^http/, "ws") + "/api/v1/ws";
    return new CexyWebSocket({
      ...options,
      allowInsecure: options.allowInsecure ?? this.#allowInsecure,
      url,
      restClient: this,
      userAgent: options.userAgent ?? this.#transport.config.userAgent ?? undefined,
    });
  }

  toString(): string {
    const auth = this.#transport.config.authenticator;
    return `CexyClient(${this.#baseUrl}, auth=${auth ? `${auth.kind} [REDACTED]` : "none"})`;
  }

  toJSON(): Record<string, unknown> {
    const auth = this.#transport.config.authenticator;
    return { baseUrl: this.#baseUrl, auth: auth ? `${auth.kind} [REDACTED]` : "none" };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/** Browsers forbid scripts from setting User-Agent; everywhere else we set it. */
function canSetUserAgent(): boolean {
  const g = globalThis as { window?: { document?: unknown }; navigator?: { product?: string } };
  return !(typeof g.window !== "undefined" && typeof g.window.document !== "undefined");
}
