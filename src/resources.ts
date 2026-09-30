import type { operations } from "./generated/schema.js";
import { assertAmountFields } from "./amounts.js";
import {
  CancelAllInterruptedError,
  CexyApiError,
  CexyConfigError,
  CexyConnectionError,
  CexyTimeoutError,
  ConflictError,
  MAX_SERVER_WAIT_MS,
  NotFoundError,
  OrderStateUnknownError,
  RateLimitError,
} from "./errors.js";
import { isAmbiguous, isRetryable, newId, type CallSpec, type RequestOptions, type Transport } from "./http.js";
import { OPERATIONS } from "./operations.js";
import { paginate, type IterateOptions } from "./pagination.js";
import type {
  ApiKey,
  Asset,
  Balance,
  CancelAllResult,
  CancelAllUntilDoneResult,
  CancelFailure,
  Candle,
  CursorParams,
  Deposit,
  DepositAddress,
  ExitPoolRequest,
  ExitPoolResult,
  FeeSchedule,
  Fill,
  JoinPoolRequest,
  JoinPoolResult,
  LedgerEntry,
  Market,
  Network,
  Notification,
  Order,
  OrderBook,
  Page,
  PlaceOrderRequest,
  PlaceOrderResponse,
  Pool,
  PublicTrade,
  QueryOf,
  SubAccount,
  Withdrawal,
  WithdrawalAddress,
} from "./types.js";

type Q<Op extends keyof operations> = QueryOf<Op>;

/** Shared plumbing for the resource namespaces. */
abstract class Resource {
  protected readonly t: Transport;
  constructor(transport: Transport) {
    this.t = transport;
  }
  protected async data<T>(spec: CallSpec, opts?: RequestOptions): Promise<T> {
    const raw = await this.t.request(spec, opts);
    return (raw.data as { data: T }).data;
  }
  protected async page<T>(spec: CallSpec, opts?: RequestOptions): Promise<Page<T>> {
    const raw = await this.t.request(spec, opts);
    return raw.data as Page<T>;
  }
  protected async text(spec: CallSpec, opts?: RequestOptions): Promise<string> {
    const raw = await this.t.request({ ...spec, responseType: "text" }, opts);
    return raw.data as string;
  }
}

function withoutCursor<P extends CursorParams>(p: P | undefined): P {
  const { cursor: _c, ...rest } = (p ?? {}) as P;
  return rest as P;
}

// ---------------------------------------------------------------------------------------
// Public market data
// ---------------------------------------------------------------------------------------

export class MarketsResource extends Resource {
  /** All markets with their current ticker. */
  list(opts?: RequestOptions): Promise<Market[]> {
    return this.data({ op: "list_markets" }, opts);
  }
  /** One market, e.g. `"BTC/USDT"`. */
  get(symbol: string, opts?: RequestOptions): Promise<Market> {
    return this.data({ op: "get_market", pathParams: { symbol } }, opts);
  }
  /**
   * Order-book snapshot aggregated by price, with the realtime `sequence` it is current as of.
   * To follow the book live, use `CexyWebSocket.orderBook()`, which applies the sync rules.
   */
  orderbook(symbol: string, params?: Q<"get_order_book">, opts?: RequestOptions): Promise<OrderBook> {
    return this.data({ op: "get_order_book", pathParams: { symbol }, query: params }, opts);
  }
  /** One page of recent public trades. */
  trades(symbol: string, params?: Q<"get_market_trades">, opts?: RequestOptions): Promise<Page<PublicTrade>> {
    return this.page({ op: "get_market_trades", pathParams: { symbol }, query: params }, opts);
  }
  /** Every public trade, page by page (`for await`). */
  iterateTrades(
    symbol: string,
    params?: Q<"get_market_trades">,
    iter?: IterateOptions & RequestOptions,
  ): AsyncGenerator<PublicTrade, void, undefined> {
    return paginate((cursor) => this.trades(symbol, { ...withoutCursor(params), cursor }, iter), params?.cursor, iter);
  }
  /** OHLCV candles. `interval` is required. */
  candles(symbol: string, params: Q<"get_candles">, opts?: RequestOptions): Promise<Candle[]> {
    return this.data({ op: "get_candles", pathParams: { symbol }, query: params }, opts);
  }
}

export class AssetsResource extends Resource {
  list(opts?: RequestOptions): Promise<Asset[]> {
    return this.data({ op: "list_assets" }, opts);
  }
  get(symbol: string, opts?: RequestOptions): Promise<Asset> {
    return this.data({ op: "get_asset", pathParams: { symbol } }, opts);
  }
}

export class NetworksResource extends Resource {
  list(opts?: RequestOptions): Promise<Network[]> {
    return this.data({ op: "list_networks" }, opts);
  }
}

export class FeesResource extends Resource {
  /** The fee schedules (maker/taker rates by tier). */
  get(opts?: RequestOptions): Promise<FeeSchedule[]> {
    return this.data({ op: "list_fee_schedules" }, opts);
  }
}

export class PoolsResource extends Resource {
  list(opts?: RequestOptions): Promise<Pool[]> {
    return this.data({ op: "list_pools" }, opts);
  }
  get(symbol: string, opts?: RequestOptions): Promise<Pool> {
    return this.data({ op: "get_pool", pathParams: { symbol } }, opts);
  }
  /** Adds liquidity. Needs the `trade` scope. Amounts are decimal strings. */
  async join(symbol: string, body: JoinPoolRequest, opts?: RequestOptions): Promise<JoinPoolResult> {
    assertAmountFields(body, ["base_amount", "quote_amount", "max_ratio_deviation_percent"], "pools.join");
    return this.data({ op: "join_pool", pathParams: { symbol }, body }, opts);
  }
  /** Removes liquidity. Needs the `trade` scope. */
  async exit(symbol: string, body: ExitPoolRequest, opts?: RequestOptions): Promise<ExitPoolResult> {
    assertAmountFields(body, ["shares"], "pools.exit");
    return this.data({ op: "exit_pool", pathParams: { symbol }, body }, opts);
  }
}

// ---------------------------------------------------------------------------------------
// Private (API key, read scope unless stated)
// ---------------------------------------------------------------------------------------

/**
 * `held_incoming` lists incoming internal transfers still held (at most 100, soonest `available_at`
 * first; `available_at` has millisecond precision; no sender identity). Their sum is ALREADY
 * INCLUDED in `locked`: never add them to `locked` or `total` again. An entry disappears once the
 * transfer is released (its amount moves to `available`) or cancelled by the exchange. Always an
 * array: servers that predate the field decode as `[]`.
 */
function withHeldIncoming(b: Balance): Balance {
  if (!b || typeof b !== "object") return b;
  // Servers that predate `sequence` (live balances) omit it: 0 means "never touched".
  const seq = typeof (b as Partial<Balance>).sequence === "number" ? b.sequence : 0;
  if (Array.isArray(b.held_incoming) && seq === b.sequence) return b;
  return { ...b, held_incoming: Array.isArray(b.held_incoming) ? b.held_incoming : [], sequence: seq };
}

export class AccountResource extends Resource {
  /**
   * The id of the account this API key belongs to (the same hex as the WebSocket's
   * `authenticated` user id). `liveBalances()` uses it to check that REST snapshots and WebSocket
   * events belong to the same account.
   */
  async id(opts?: RequestOptions): Promise<string> {
    const r = await this.data<{ user_id: string }>({ op: "get_account_id" }, opts);
    return r.user_id;
  }
  /**
   * Balances per asset. `held_incoming` lists incoming internal transfers still held; their sum is
   * already included in `locked` (never add it again). Always an array (`[]` when none).
   */
  async balances(opts?: RequestOptions): Promise<Balance[]> {
    const rows = await this.data<Balance[]>({ op: "list_balances" }, opts);
    return Array.isArray(rows) ? rows.map(withHeldIncoming) : rows;
  }
  /** One asset's balance. `held_incoming`: incoming transfers still held, already inside `locked`. */
  async balance(asset: string, opts?: RequestOptions): Promise<Balance> {
    return withHeldIncoming(await this.data<Balance>({ op: "get_balance", pathParams: { asset } }, opts));
  }
  ledger(params?: Q<"get_ledger">, opts?: RequestOptions): Promise<Page<LedgerEntry>> {
    return this.page({ op: "get_ledger", query: params }, opts);
  }
  iterateLedger(params?: Q<"get_ledger">, iter?: IterateOptions & RequestOptions): AsyncGenerator<LedgerEntry, void, undefined> {
    return paginate((cursor) => this.ledger({ ...withoutCursor(params), cursor }, iter), params?.cursor, iter);
  }
  notifications(params?: Q<"list_notifications">, opts?: RequestOptions): Promise<Page<Notification>> {
    return this.page({ op: "list_notifications", query: params }, opts);
  }
  iterateNotifications(
    params?: Q<"list_notifications">,
    iter?: IterateOptions & RequestOptions,
  ): AsyncGenerator<Notification, void, undefined> {
    return paginate((cursor) => this.notifications({ ...withoutCursor(params), cursor }, iter), params?.cursor, iter);
  }
  subAccounts(opts?: RequestOptions): Promise<SubAccount[]> {
    return this.data({ op: "list_sub_accounts" }, opts);
  }
  /**
   * A sub-account's balances, read by its PARENT account: the same shape as `balances()`
   * (zero balances omitted), including `held_incoming`, whose sum is already inside `locked`.
   * The server currently returns them ordered by asset symbol; don't rely on the order.
   * An id that is not one of the caller's sub-accounts (or a call with the sub-account's own
   * key) gets `NotFoundError`; a sub-account's own key reads its balances with `balances()`.
   * A malformed id gets 400 (`ValidationError`); a key without the `read` scope gets 403
   * `FORBIDDEN` (`ForbiddenError`). `id` must be non-empty and not "." or ".."; it is sent as
   * one URL path segment.
   */
  async subAccountBalances(id: string, opts?: RequestOptions): Promise<Balance[]> {
    const rows = await this.data<Balance[]>({ op: "sub_account_balances", pathParams: { id } }, opts);
    return Array.isArray(rows) ? rows.map(withHeldIncoming) : rows;
  }
  /** Your API keys (metadata only; secrets are never returned). */
  apiKeys(opts?: RequestOptions): Promise<ApiKey[]> {
    return this.data({ op: "list_api_keys" }, opts);
  }
}

/** CSV exports. Each method returns the CSV text. `from`/`to` are RFC 3339 date-times. */
export class ExportsResource extends Resource {
  deposits(params?: Q<"export_deposits">, opts?: RequestOptions): Promise<string> {
    return this.text({ op: "export_deposits", query: params }, opts);
  }
  ledger(params?: Q<"export_ledger">, opts?: RequestOptions): Promise<string> {
    return this.text({ op: "export_ledger", query: params }, opts);
  }
  orders(params?: Q<"export_orders">, opts?: RequestOptions): Promise<string> {
    return this.text({ op: "export_orders", query: params }, opts);
  }
  trades(params?: Q<"export_trades">, opts?: RequestOptions): Promise<string> {
    return this.text({ op: "export_trades", query: params }, opts);
  }
  withdrawals(params?: Q<"export_withdrawals">, opts?: RequestOptions): Promise<string> {
    return this.text({ op: "export_withdrawals", query: params }, opts);
  }
}

/** Wallet reads. API keys can never withdraw or transfer; there are no such methods. */
export class WalletResource extends Resource {
  deposits(params?: Q<"list_deposits">, opts?: RequestOptions): Promise<Page<Deposit>> {
    return this.page({ op: "list_deposits", query: params }, opts);
  }
  iterateDeposits(params?: Q<"list_deposits">, iter?: IterateOptions & RequestOptions): AsyncGenerator<Deposit, void, undefined> {
    return paginate((cursor) => this.deposits({ ...withoutCursor(params), cursor }, iter), params?.cursor, iter);
  }
  deposit(depositId: string, opts?: RequestOptions): Promise<Deposit> {
    return this.data({ op: "get_deposit", pathParams: { deposit_id: depositId } }, opts);
  }
  withdrawals(params?: Q<"list_withdrawals">, opts?: RequestOptions): Promise<Page<Withdrawal>> {
    return this.page({ op: "list_withdrawals", query: params }, opts);
  }
  iterateWithdrawals(
    params?: Q<"list_withdrawals">,
    iter?: IterateOptions & RequestOptions,
  ): AsyncGenerator<Withdrawal, void, undefined> {
    return paginate((cursor) => this.withdrawals({ ...withoutCursor(params), cursor }, iter), params?.cursor, iter);
  }
  withdrawal(withdrawalId: string, opts?: RequestOptions): Promise<Withdrawal> {
    return this.data({ op: "get_withdrawal", pathParams: { withdrawal_id: withdrawalId } }, opts);
  }
  withdrawalAddresses(opts?: RequestOptions): Promise<WithdrawalAddress[]> {
    return this.data({ op: "list_withdrawal_addresses" }, opts);
  }
  /**
   * Your deposit address for an asset on a network.
   *
   * **Side effect:** the first call for an asset/network CREATES the address (and it is
   * permanent); later calls return the same address. Always send the `memo` too when the
   * response has one, or the deposit may be unrecoverable.
   */
  depositAddress(params: Q<"deposit_address">, opts?: RequestOptions): Promise<DepositAddress> {
    return this.data({ op: "deposit_address", query: params }, opts);
  }
}

/** `placeOrder` result. `recovered` is true when the order was found by its client id after an ambiguous failure. */
export interface PlaceOrderResult extends PlaceOrderResponse {
  /** The `client_order_id` that was sent (generated if you did not set one). */
  client_order_id: string;
  /**
   * True if the POST failed ambiguously and the order was then found by `client_order_id`.
   * In that case `fills` is empty; use `trading.trades({ symbol })` for executions.
   */
  recovered: boolean;
}

/**
 * `cancelAll` target. `symbol` is required: a market such as `"BTC/USDT"`, or `null` to
 * cancel in EVERY market (only when passed explicitly).
 */
export interface CancelAllParams {
  symbol: string | null;
  /**
   * Repeat the call until nothing is left to retry (see `cancelAll`). Default false: one call.
   */
  untilDone?: boolean;
  /** With `untilDone`: at most this many calls. Default 20. */
  maxRounds?: number;
  /** With `untilDone`: stop before a wait would take the loop to this many ms. Default 120000. */
  timeBudgetMs?: number;
}

/** Failure codes that clear up on their own: an order still being placed, a state read failure. */
const CANCEL_RETRY_CODES = new Set(["INVALID_STATE", "SERVICE_UNAVAILABLE"]);
/** Waits after rounds without progress, in seconds; the last value repeats. */
const CANCEL_BACKOFF_S = [1, 2, 4, 8, 15];

/** A short code for a retryable failure, for `last_error_code`. */
function errorCode(err: unknown): string {
  if (err instanceof CexyApiError) return err.code;
  if (err instanceof CexyTimeoutError) return "TIMEOUT";
  if (err instanceof CexyConnectionError) return "CONNECTION_ERROR";
  return "ERROR";
}

const ORDER_AMOUNT_FIELDS = ["price", "quantity", "quote_quantity", "stop_price"] as const;

export class TradingResource extends Resource {
  /** Open orders, optionally filtered by market/status. */
  openOrders(params?: Q<"list_open_orders">, opts?: RequestOptions): Promise<Order[]> {
    return this.data({ op: "list_open_orders", query: params }, opts);
  }
  order(orderId: string, opts?: RequestOptions): Promise<Order> {
    return this.data({ op: "get_order", pathParams: { order_id: orderId } }, opts);
  }
  orderByClientId(clientOrderId: string, opts?: RequestOptions): Promise<Order> {
    return this.data({ op: "get_order_by_client_id", pathParams: { client_order_id: clientOrderId } }, opts);
  }
  orderHistory(params?: Q<"order_history">, opts?: RequestOptions): Promise<Page<Order>> {
    return this.page({ op: "order_history", query: params }, opts);
  }
  iterateOrderHistory(params?: Q<"order_history">, iter?: IterateOptions & RequestOptions): AsyncGenerator<Order, void, undefined> {
    return paginate((cursor) => this.orderHistory({ ...withoutCursor(params), cursor }, iter), params?.cursor, iter);
  }
  /** Your executions. */
  trades(params?: Q<"trade_history">, opts?: RequestOptions): Promise<Page<Fill>> {
    return this.page({ op: "trade_history", query: params }, opts);
  }
  iterateTrades(params?: Q<"trade_history">, iter?: IterateOptions & RequestOptions): AsyncGenerator<Fill, void, undefined> {
    return paginate((cursor) => this.trades({ ...withoutCursor(params), cursor }, iter), params?.cursor, iter);
  }

  /**
   * Places a REAL order (needs the `trade` scope). Amounts must be decimal strings.
   *
   * Retry safety rests on `client_order_id` (generated as a UUID when absent): it is unique
   * per account and the server refuses a repeat before any funds move. The server does NOT
   * honour `Idempotency-Key` on orders, so none is sent. After an
   * ambiguous failure (network error, timeout or 5xx) the SDK first looks the order up by
   * `client_order_id` and returns it if it exists (`recovered: true`); only if it does not
   * exist does it send the order again, with the same `client_order_id`, so a late-arriving
   * first attempt makes the resend fail as a duplicate, which is again resolved by lookup.
   * Throws `OrderStateUnknownError` when even the lookup fails.
   */
  async placeOrder(order: PlaceOrderRequest, opts: RequestOptions = {}): Promise<PlaceOrderResult> {
    if (!order || typeof order !== "object") throw new CexyConfigError("placeOrder(): order is required");
    for (const f of ["symbol", "side", "type"] as const) {
      if (!order[f]) throw new CexyConfigError(`placeOrder(): ${f} is required`);
    }
    assertAmountFields(order, ORDER_AMOUNT_FIELDS, "placeOrder");
    const clientOrderId = order.client_order_id ?? newId();
    const body: PlaceOrderRequest = { ...order, client_order_id: clientOrderId };
    const maxRetries = opts.maxRetries ?? this.t.config.maxRetries;
    const info = OPERATIONS.place_order;

    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await this.t.attempt({ op: "place_order", body }, opts);
        const data = (raw.data as { data: PlaceOrderResponse }).data;
        return { ...data, client_order_id: clientOrderId, recovered: false };
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const duplicateAfterRetry =
          attempt > 0 && err instanceof ConflictError && (err.code === "ALREADY_EXISTS" || err.code === "IDEMPOTENCY_KEY_CONFLICT");
        if (isAmbiguous(err) || duplicateAfterRetry) {
          const existing = await this.#lookup(clientOrderId, err, opts);
          if (existing) return { order: existing, fills: [], client_order_id: clientOrderId, recovered: true };
          if (duplicateAfterRetry || attempt >= maxRetries) throw err;
          await this.t.backoff("place_order", info, attempt, err, undefined, opts.signal);
          continue;
        }
        // Definitive refusals that did not execute (e.g. 429): resend with the same client_order_id.
        if (isRetryable(err) && attempt < maxRetries) {
          await this.t.backoff("place_order", info, attempt, err, undefined, opts.signal);
          continue;
        }
        throw err;
      }
    }
  }

  async #lookup(clientOrderId: string, original: unknown, opts: RequestOptions): Promise<Order | null> {
    try {
      return await this.orderByClientId(clientOrderId, { signal: opts.signal, timeoutMs: opts.timeoutMs });
    } catch (lookupErr) {
      if (lookupErr instanceof NotFoundError) return null;
      throw new OrderStateUnknownError(clientOrderId, original);
    }
  }

  /**
   * Cancels one order (needs the `trade` scope). Retried on network errors and retryable
   * responses. If a RETRY gets `INVALID_STATE` (the order is no longer open, typically because
   * the first attempt did cancel it), the cancel is treated as done and the order is fetched
   * and returned. `INVALID_STATE` on the first attempt is thrown (e.g. already filled).
   */
  async cancelOrder(orderId: string, opts: RequestOptions = {}): Promise<Order> {
    const maxRetries = opts.maxRetries ?? this.t.config.maxRetries;
    const info = OPERATIONS.cancel_order;
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await this.t.attempt({ op: "cancel_order", pathParams: { order_id: orderId } }, opts);
        return (raw.data as { data: Order }).data;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (attempt > 0 && err instanceof CexyApiError && err.code === "INVALID_STATE") {
          return this.order(orderId, { signal: opts.signal, timeoutMs: opts.timeoutMs });
        }
        if (isRetryable(err) && attempt < maxRetries) {
          await this.t.backoff("cancel_order", info, attempt, err, undefined, opts.signal);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Cancels every open order in one market: `cancelAll({ symbol: "BTC/USDT" })`.
   * This includes stop orders that have not triggered yet (status `pending_trigger`): they are
   * cancelled and their reservations released, so nothing fires into the market afterwards.
   * To cancel across ALL markets, pass `symbol: null` explicitly: `cancelAll({ symbol: null })`.
   * Omitting `symbol` is an error, so an account-wide cancel never happens by accident
   * (the server itself treats `{}` as every market). An unknown symbol throws `NotFoundError`.
   *
   * One call handles at most 500 orders. Every order it handled is in exactly one list:
   * `cancelled`; `already_closed` (it filled, was refused or was cancelled elsewhere first:
   * not an error); or `failed`, with the reason in `failures` (`INVALID_STATE` for an order
   * still being placed when the server's 500 ms wait ran out). `has_more` says more orders
   * remain: call again.
   *
   * With `untilDone: true` the SDK does that for you. It repeats while `has_more` is true or a
   * failure is `INVALID_STATE` / `SERVICE_UNAVAILABLE`. After a call that made no progress it
   * waits 1, 2, 4, 8 and then 15 s, starting over after any progress. It stops after
   * `maxRounds` calls or before a wait would pass `timeBudgetMs`, and returns the merged
   * result with `rounds` and `stopped`. Other failure codes are returned, never retried.
   * In this mode every round is exactly one HTTP request (the loop owns the retries, so it
   * never sends more than `maxRounds` requests): a 429 round waits the server's Retry-After
   * (without advancing the backoff), another retryable error (5xx, network) takes the next
   * backoff step, and a wait that would pass the budget ends the loop with
   * `stopped: "time_budget"` and `last_error_code`. A non-retryable error (e.g. a key without
   * the trade scope) throws `CancelAllInterruptedError`, which carries the error and the
   * partial result.
   *
   * The server allows 30 cancel-all calls per minute per account. A single call (without
   * `untilDone`) follows the normal retry policy: a 429 is retried after its Retry-After (up to
   * 120 s; a longer one fails at once) and network errors are retried, since the call is
   * naturally repeatable; a retry reports only what that retry did. No Idempotency-Key is sent.
   */
  cancelAll(params: CancelAllParams & { untilDone: true }, opts?: RequestOptions): Promise<CancelAllUntilDoneResult>;
  cancelAll(params: CancelAllParams, opts?: RequestOptions): Promise<CancelAllResult>;
  async cancelAll(params: CancelAllParams, opts?: RequestOptions): Promise<CancelAllResult | CancelAllUntilDoneResult> {
    const hasSymbol = !!params && typeof params === "object" && Object.prototype.hasOwnProperty.call(params, "symbol");
    const symbol: unknown = hasSymbol ? params.symbol : undefined;
    let body: { symbol?: string };
    if (typeof symbol === "string" && symbol !== "") body = { symbol };
    else if (hasSymbol && symbol === null) body = {};
    else throw new CexyConfigError('cancelAll(): pass { symbol: "BASE/QUOTE" }, or { symbol: null } to cancel in every market');
    const once = (o?: RequestOptions) => this.data<CancelAllResult>({ op: "cancel_all", body }, o ?? opts);
    if (params.untilDone !== true) return once();

    const maxRounds = params.maxRounds ?? 20;
    const budgetMs = params.timeBudgetMs ?? 120_000;
    if (!(maxRounds >= 1)) throw new CexyConfigError("cancelAll(): maxRounds must be >= 1");
    if (!(budgetMs > 0)) throw new CexyConfigError("cancelAll(): timeBudgetMs must be > 0");
    const now = this.t.config.now ?? Date.now;
    const start = now();
    const state = new Map<string, { list: "cancelled" | "already_closed" | "failed"; failure?: CancelFailure }>();
    // Each round is exactly one HTTP request: the loop owns the retries, so it never sends more
    // than maxRounds requests and never waits past the budget.
    const roundOpts: RequestOptions = { ...opts, maxRetries: 0 };
    let rounds = 0;
    let idle = 0;
    let hasMore = false;
    let lastErrorCode: string | undefined;
    let stopped: CancelAllUntilDoneResult["stopped"];
    const result = (): CancelAllUntilDoneResult => {
      const pick = (list: string) => [...state].filter(([, v]) => v.list === list).map(([id]) => id);
      return {
        cancelled: pick("cancelled"),
        already_closed: pick("already_closed"),
        failed: pick("failed"),
        failures: [...state.values()].flatMap((v) => (v.list === "failed" && v.failure ? [v.failure] : [])),
        has_more: hasMore,
        rounds,
        stopped,
        ...(lastErrorCode !== undefined ? { last_error_code: lastErrorCode } : {}),
      };
    };
    for (;;) {
      let waitMs = 0;
      let res: CancelAllResult | undefined;
      try {
        res = await once(roundOpts);
      } catch (err) {
        rounds++;
        if (opts?.signal?.aborted) throw err;
        if (!isRetryable(err)) {
          stopped = "done";
          throw new CancelAllInterruptedError(err, result());
        }
        lastErrorCode = errorCode(err);
        if (rounds >= maxRounds) {
          stopped = "max_rounds";
          break;
        }
        const hint = err instanceof RateLimitError ? err.retryAfterMs : null;
        if (hint !== null) {
          waitMs = hint; // exactly the server's wait; the backoff does not advance
          if (hint > MAX_SERVER_WAIT_MS) {
            stopped = "time_budget";
            break;
          }
        } else {
          waitMs = (CANCEL_BACKOFF_S[Math.min(idle++, CANCEL_BACKOFF_S.length - 1)] ?? 15) * 1000;
        }
      }
      if (res) {
        rounds++;
        lastErrorCode = undefined;
        hasMore = res.has_more;
        const failures = res.failures ?? [];
        for (const id of res.cancelled ?? []) state.set(id, { list: "cancelled" });
        for (const id of res.already_closed ?? []) state.set(id, { list: "already_closed" });
        for (const id of res.failed ?? []) {
          const failure = failures.find((f) => f.order_id === id);
          state.set(id, failure ? { list: "failed", failure } : { list: "failed" });
        }
        const progress = (res.cancelled?.length ?? 0) + (res.already_closed?.length ?? 0) > 0;
        if (!res.has_more && !failures.some((f) => CANCEL_RETRY_CODES.has(f.code))) {
          stopped = "done";
          break;
        }
        if (rounds >= maxRounds) {
          stopped = "max_rounds";
          break;
        }
        if (progress) idle = 0;
        else waitMs = (CANCEL_BACKOFF_S[Math.min(idle++, CANCEL_BACKOFF_S.length - 1)] ?? 15) * 1000;
      }
      // The client rate limiter may hold the next round (e.g. X-RateLimit-Remaining 0 with a
      // Reset): that wait happens inside the request, so count it against the budget here.
      const limiterMs = this.t.config.limiter?.pendingWaitMs() ?? 0;
      if (now() - start + Math.max(waitMs, limiterMs) >= budgetMs) {
        stopped = "time_budget";
        if (limiterMs > waitMs) lastErrorCode = "RATE_LIMITED";
        break;
      }
      if (waitMs > 0) await this.t.config.sleep(waitMs, opts?.signal);
    }
    return result();
  }
}
