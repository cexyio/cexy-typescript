/**
 * Friendly names for the generated API models (src/generated/schema.ts).
 * Amounts are decimal strings; never convert them to `number`.
 */
import type { components, operations } from "./generated/schema.js";

export type { components, operations, paths } from "./generated/schema.js";

type S = components["schemas"];

export type ApiKey = S["ApiKeyResponse"];
export type ApiScope = S["ApiScope"];
export type Asset = S["AssetResponse"];
export type AssetNetwork = S["AssetNetworkResponse"];
export type Balance = S["BalanceResponse"];
/** An incoming internal transfer still held (see `Balance.held_incoming`). */
export type HeldIncoming = S["HeldIncomingResponse"];
export type CancelAllRequest = S["CancelAllRequest"];
export type CancelAllResult = S["CancelAllResponse"];
/** Result of `trading.cancelAllAfter`: the dead-man switch as just set. */
export type CancelAllAfterResult = S["CancelAllAfterResponse"];
/** Why one order could not be cancelled (`CancelAllResult.failures`). */
export type CancelFailure = S["CancelFailureResponse"];
/** Why a `cancelAll({ ..., untilDone: true })` loop ended. */
export type CancelAllStopReason = "done" | "max_rounds" | "time_budget";
/**
 * Merged result of a `cancelAll({ ..., untilDone: true })` loop. Every order is in exactly one
 * of `cancelled`, `already_closed` and `failed`, in its latest state; `has_more` is the last
 * round's.
 */
export interface CancelAllUntilDoneResult extends CancelAllResult {
  /** Number of cancel-all calls made. */
  rounds: number;
  /** `done`: nothing left to retry; otherwise the loop's limit that ended it. */
  stopped: CancelAllStopReason;
  /**
   * The error code of the last round when that round failed with a retryable error (e.g.
   * `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `CONNECTION_ERROR`); absent when it succeeded.
   */
  last_error_code?: string;
}
export type Candle = S["CandleResponse"];
export type CandleInterval = S["CandleInterval"];
export type DepositAddress = S["DepositAddressResponse"];
export type Deposit = S["DepositResponse"];
export type DepositStatus = S["DepositStatus"];
export type ExchangeConfig = S["ExchangeConfigResponse"];
export type ExitPoolRequest = S["ExitPoolRequest"];
export type ExitPoolResult = S["ExitPoolResponse"];
export type FeeSchedule = S["FeeScheduleResponse"];
export type Fill = S["FillResponse"];
export type JoinPoolRequest = S["JoinPoolRequest"];
export type JoinPoolResult = S["JoinPoolResponse"];
/** A ledger entry. `reference` also accepts cause types this SDK version does not know yet. */
export type LedgerEntry = Omit<S["LedgerEntryResponse"], "reference"> & { reference: LedgerReference };
/** What caused a ledger entry, as documented: one variant per `type`. */
export type KnownLedgerReference = S["LedgerReference"];
/** The documented `LedgerReference` types. */
export type LedgerReferenceType = KnownLedgerReference["type"];
/**
 * A cause type this SDK version does not know yet (the server may add new ones). The object is
 * kept as sent. Use `isLedgerReference()` to narrow to a documented variant.
 */
export interface UnknownLedgerReference {
  type: string;
  [field: string]: unknown;
}
/** `LedgerEntry.reference`: a documented variant or an unknown one; never throws on new types. */
export type LedgerReference = KnownLedgerReference | UnknownLedgerReference;

// Ids are opaque strings. The API documents today's format (24 hex characters), but the SDK does
// not validate it, so a future format does not break clients.
export type DepositId = S["DepositId"];
export type FuturesTransferId = S["FuturesTransferId"];
export type OrderId = S["OrderId"];
export type PoolId = S["PoolId"];
export type TradeId = S["TradeId"];
export type UserId = S["UserId"];
export type WithdrawalId = S["WithdrawalId"];
export type LedgerEntryKind = S["LedgerEntryKind"];
export type LiquidityRole = S["LiquidityRole"];
export type MaintenanceState = S["MaintenanceState"];
export type Market = S["MarketResponse"];
export type MarketStatus = S["MarketStatus"];
export type Network = S["NetworkResponse"];
export type Notification = S["NotificationResponse"];
export type NotificationKind = S["NotificationKind"];
export type OrderBook = S["OrderBookResponse"];
export type Order = S["OrderResponse"];
export type OrderSide = S["OrderSide"];
export type OrderStatus = S["OrderStatus"];
export type OrderType = S["OrderType"];
export type PlaceOrderRequest = S["PlaceOrderRequest"];
export type PlaceOrderResponse = S["PlaceOrderResponse"];
export type Pool = S["PoolResponse"];
export type PoolStatus = S["PoolStatus"];
export type PublicTrade = S["PublicTradeResponse"];
export type ServerTime = S["ServerTimeResponse"];
export type SortDirection = S["SortDirection"];
export type SubAccount = S["SubAccountResponse"];
export type TimeInForce = S["TimeInForce"];
export type TriggerDirection = S["TriggerDirection"];
export type WithdrawalAddress = S["WithdrawalAddressResponse"];
export type Withdrawal = S["WithdrawalResponse"];
export type WithdrawalStatus = S["WithdrawalStatus"];

// Futures data (read only). Generated names are kept, except where they collide with the spot
// models above (`Candle`, `Fill`, `PublicTrade`): those get a `Futures` prefix.
/** One listed perpetual market and its current figures. */
export type PerpMarket = S["PerpMarket"];
/** Every listed futures market, with `as_of` and `stale`. */
export type FuturesMarkets = S["FuturesMarketsResponse"];
/** One futures market, with `as_of` and `stale`. */
export type FuturesMarket = S["FuturesMarketResponse"];
/** A futures order book. `stale` is the live feed's health, not the book's age. */
export type FuturesBook = S["FuturesBookResponse"];
/** One price level of a futures book. */
export type Level = S["Level"];
/** A futures market's candles (oldest first). */
export type FuturesCandles = S["FuturesCandlesResponse"];
/** One futures candle (generated name `Candle`; renamed: `Candle` is the spot candle). */
export type FuturesCandle = S["Candle"];
/** A futures market's recent public trades (newest first). */
export type FuturesTrades = S["FuturesTradesResponse"];
/** One futures public trade (generated name `PublicTrade`; renamed: `PublicTrade` is spot's). */
export type FuturesPublicTrade = S["PublicTrade"];
/** The account's margin summary and positions (`has_account: false` without a futures account). */
export type FuturesPositions = S["FuturesPositionsResponse"];
/** A margin summary and the open positions. */
export type Positions = S["Positions"];
/** One open futures position. */
export type Position = S["Position"];
/** The account's open futures orders. */
export type FuturesOpenOrders = S["FuturesOpenOrdersResponse"];
/** One open futures order. */
export type OpenOrder = S["OpenOrder"];
/** A page of the account's futures fills. */
export type FuturesFills = S["FuturesFillsResponse"];
/** One futures fill (generated name `Fill`; renamed: `Fill` is the spot fill). */
export type FuturesFill = S["Fill"];
/** A page of the account's funding payments. */
export type FuturesFunding = S["FuturesFundingResponse"];
/** One funding payment. */
export type Funding = S["Funding"];

/** Query parameters of an operation, from the spec. */
export type QueryOf<Op extends keyof operations> = NonNullable<operations[Op]["parameters"]["query"]>;

/** One page of a cursor-paginated listing. */
export interface Page<T> {
  items: T[];
  has_more: boolean;
  /** Pass back as `cursor` to get the next page. Absent on the last page. */
  next_cursor?: string;
}

/** Cursor paging parameters shared by every paginated listing. */
export interface CursorParams {
  cursor?: string | null;
  limit?: number | null;
  direction?: SortDirection | null;
}
