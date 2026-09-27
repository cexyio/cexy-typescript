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
export type CancelAllRequest = S["CancelAllRequest"];
export type CancelAllResult = S["CancelAllResponse"];
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
export type LedgerEntry = S["LedgerEntryResponse"];
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
