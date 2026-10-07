export { CexyClient, DEFAULT_BASE_URL, DEFAULT_RPM_ANONYMOUS, DEFAULT_RPM_WITH_KEY, type CexyClientOptions } from "./client.js";
export { ApiKeyAuthenticator, type AuthRequest, type Authenticator } from "./auth.js";
export { HmacAuthenticator, MAX_CLOCK_OFFSET_MS, SIGNING_SCHEME } from "./signing.js";
export {
  AuthenticationError,
  CexyApiError,
  CexyConfigError,
  CexyConnectionError,
  CexyError,
  CexyTimeoutError,
  ConflictError,
  ForbiddenError,
  JurisdictionBlockedError,
  InvalidAmountError,
  NotFoundError,
  OrderStateUnknownError,
  PagingCursorRepeatedError,
  PagingStalledError,
  CancelAllInterruptedError,
  MAX_SERVER_WAIT_MS,
  RateLimitError,
  ServerError,
  UnprocessableError,
  ValidationError,
  errorFromResponse,
  isKnownErrorCode,
  CLIENT_ERROR_CODES,
  type CexyApiErrorInit,
  type ErrorBody,
  type ErrorCode,
  type KnownErrorCode,
} from "./errors.js";
export { assertAmountFields, isAmount, type Amount } from "./amounts.js";
export { RateLimiter, type RateLimiterOptions, type RateLimiterState } from "./limiter.js";
export { isRetryable, type FetchLike, type RequestOptions, type RetryInfo } from "./http.js";
export { OPERATIONS, type OperationAuth, type OperationId, type OperationInfo, type OperationScope } from "./operations.js";
export { paginate, type IterateOptions } from "./pagination.js";
export {
  AccountResource,
  AssetsResource,
  ExportsResource,
  FeesResource,
  FuturesResource,
  MarketsResource,
  NetworksResource,
  PoolsResource,
  TradingResource,
  WalletResource,
  type CancelAllParams,
  type CancelAllAfterParams,
  type FuturesHistoryEnd,
  type FuturesIterateOptions,
  type PlaceOrderResult,
} from "./resources.js";
export * from "./types.js";
export { isLedgerReference } from "./ledger.js";
export {
  CexyWebSocket,
  CexyWebSocketError,
  DEFAULT_PING_INTERVAL_MS,
  canonicalChannel,
  DEFAULT_WS_URL,
  MAX_PING_INTERVAL_MS,
  REAL_CLOCK,
  futuresChannel,
  type AuthChange,
  type AuthChangeReason,
  type AuthResult,
  type CexyWebSocketEvents,
  type CexyWebSocketOptions,
  type CloseInfo,
  type ReconnectOptions,
  type ResyncReason,
  type SequenceGap,
  type WsClock,
  type SnapshotSource,
  type SubscribeRejection,
  type SubscribeResult,
  type WsLogger,
  type WsKeySigner,
} from "./ws/client.js";
export { LiveOrderBook, WS_BOOK_DEPTH, type LiveOrderBookEvents, type LiveOrderBookOptions } from "./ws/orderbook.js";
export { TypedEmitter, type EventMap, type Listener } from "./ws/emitter.js";
export * from "./ws/types.js";
export { USER_AGENT, VERSION } from "./version.js";
export { isLocalHost } from "./url.js";
export {
  AccountMismatchError,
  LiveBalances,
  type LiveBalancesEvents,
  type LiveBalancesOptions,
  type LiveBalancesSnapshotReason,
} from "./ws/balances.js";
