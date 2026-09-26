import type { operations } from "./generated/schema.js";
import { assertAmountFields } from "./amounts.js";
import { CexyApiError, CexyConfigError, ConflictError, NotFoundError, OrderStateUnknownError } from "./errors.js";
import { isAmbiguous, isRetryable, newId, type CallSpec, type RequestOptions, type Transport } from "./http.js";
import { OPERATIONS } from "./operations.js";
import { paginate, type IterateOptions } from "./pagination.js";
import type {
  ApiKey,
  Asset,
  Balance,
  CancelAllResult,
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

export class AccountResource extends Resource {
  balances(opts?: RequestOptions): Promise<Balance[]> {
    return this.data({ op: "list_balances" }, opts);
  }
  balance(asset: string, opts?: RequestOptions): Promise<Balance> {
    return this.data({ op: "get_balance", pathParams: { asset } }, opts);
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
   * honour `Idempotency-Key` on orders (the header is sent but gives no protection). After an
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
    const idempotencyKey = opts.idempotencyKey ?? newId();
    const maxRetries = opts.maxRetries ?? this.t.config.maxRetries;
    const info = OPERATIONS.place_order;

    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await this.t.attempt({ op: "place_order", body, idempotencyKey }, opts);
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
          await this.t.backoff("place_order", info, attempt, err, idempotencyKey, opts.signal);
          continue;
        }
        // Definitive refusals that did not execute (e.g. 429): resend with the same client_order_id.
        if (isRetryable(err) && attempt < maxRetries) {
          await this.t.backoff("place_order", info, attempt, err, idempotencyKey, opts.signal);
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
    const idempotencyKey = opts.idempotencyKey ?? newId(); // sent, but not honoured for cancels
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await this.t.attempt({ op: "cancel_order", pathParams: { order_id: orderId }, idempotencyKey }, opts);
        return (raw.data as { data: Order }).data;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (attempt > 0 && err instanceof CexyApiError && err.code === "INVALID_STATE") {
          return this.order(orderId, { signal: opts.signal, timeoutMs: opts.timeoutMs });
        }
        if (isRetryable(err) && attempt < maxRetries) {
          await this.t.backoff("cancel_order", info, attempt, err, idempotencyKey, opts.signal);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Cancels every open order in one market: `cancelAll({ symbol: "BTC/USDT" })`.
   * To cancel across ALL markets, pass `symbol: null` explicitly: `cancelAll({ symbol: null })`.
   * Omitting `symbol` is an error, so an account-wide cancel never happens by accident
   * (the server itself treats `{}` as every market).
   *
   * The server limits cancel-all to 30 calls per minute per account. It is naturally
   * repeatable, so it is retried after network errors; a retry reports only what that retry
   * cancelled.
   */
  async cancelAll(params: CancelAllParams, opts?: RequestOptions): Promise<CancelAllResult> {
    const hasSymbol = !!params && typeof params === "object" && Object.prototype.hasOwnProperty.call(params, "symbol");
    const symbol: unknown = hasSymbol ? params.symbol : undefined;
    let body: { symbol?: string };
    if (typeof symbol === "string" && symbol !== "") body = { symbol };
    else if (hasSymbol && symbol === null) body = {};
    else throw new CexyConfigError('cancelAll(): pass { symbol: "BASE/QUOTE" }, or { symbol: null } to cancel in every market');
    return this.data({ op: "cancel_all", body }, opts);
  }
}
