/**
 * The SDK surface: exactly the operations in cexy-api-spec/spec/openapi.sdk.json.
 * `auth` decides whether credentials are attached; a test asserts this table against the spec.
 */
export type OperationAuth = "none" | "api_key";
export type OperationScope = "read" | "trade" | null;
export type HttpMethod = "GET" | "POST" | "DELETE";

export interface OperationInfo {
  readonly method: HttpMethod;
  readonly path: string;
  readonly auth: OperationAuth;
  readonly scope: OperationScope;
  /** The facade method that calls it. */
  readonly sdkMethod: string;
}

const op = (
  method: HttpMethod,
  path: string,
  auth: OperationAuth,
  scope: OperationScope,
  sdkMethod: string,
): OperationInfo => ({ method, path, auth, scope, sdkMethod });

export const OPERATIONS = {
  // Public market data
  server_time: op("GET", "/api/v1/time", "none", null, "time"),
  exchange_config: op("GET", "/api/v1/config", "none", null, "config"),
  list_fee_schedules: op("GET", "/api/v1/fees", "none", null, "fees.get"),
  list_assets: op("GET", "/api/v1/assets", "none", null, "assets.list"),
  get_asset: op("GET", "/api/v1/assets/{symbol}", "none", null, "assets.get"),
  list_networks: op("GET", "/api/v1/networks", "none", null, "networks.list"),
  list_markets: op("GET", "/api/v1/markets", "none", null, "markets.list"),
  get_market: op("GET", "/api/v1/markets/{symbol}", "none", null, "markets.get"),
  get_order_book: op("GET", "/api/v1/markets/{symbol}/orderbook", "none", null, "markets.orderbook"),
  get_market_trades: op("GET", "/api/v1/markets/{symbol}/trades", "none", null, "markets.trades"),
  get_candles: op("GET", "/api/v1/markets/{symbol}/candles", "none", null, "markets.candles"),
  list_pools: op("GET", "/api/v1/pools", "none", null, "pools.list"),
  get_pool: op("GET", "/api/v1/pools/{symbol}", "none", null, "pools.get"),
  // Account (read)
  get_account_id: op("GET", "/api/v1/account/id", "api_key", "read", "account.id"),
  list_balances: op("GET", "/api/v1/account/balances", "api_key", "read", "account.balances"),
  get_balance: op("GET", "/api/v1/account/balances/{asset}", "api_key", "read", "account.balance"),
  get_ledger: op("GET", "/api/v1/account/ledger", "api_key", "read", "account.ledger"),
  list_notifications: op("GET", "/api/v1/account/notifications", "api_key", "read", "account.notifications"),
  list_sub_accounts: op("GET", "/api/v1/account/sub-accounts", "api_key", "read", "account.subAccounts"),
  sub_account_balances: op("GET", "/api/v1/account/sub-accounts/{id}/balances", "api_key", "read", "account.subAccountBalances"),
  list_api_keys: op("GET", "/api/v1/account/api-keys", "api_key", "read", "account.apiKeys"),
  // Futures data (read only). The spec's operation ids for these are short (`markets`, `fills`, ...).
  markets: op("GET", "/api/v1/futures/markets", "none", null, "futures.markets"),
  market: op("GET", "/api/v1/futures/markets/{coin}", "none", null, "futures.market"),
  orderbook: op("GET", "/api/v1/futures/markets/{coin}/orderbook", "none", null, "futures.orderBook"),
  candles: op("GET", "/api/v1/futures/markets/{coin}/candles", "none", null, "futures.candles"),
  trades: op("GET", "/api/v1/futures/markets/{coin}/trades", "none", null, "futures.trades"),
  positions: op("GET", "/api/v1/futures/positions", "api_key", "read", "futures.positions"),
  open_orders: op("GET", "/api/v1/futures/orders", "api_key", "read", "futures.openOrders"),
  fills: op("GET", "/api/v1/futures/fills", "api_key", "read", "futures.fills"),
  funding: op("GET", "/api/v1/futures/funding", "api_key", "read", "futures.funding"),
  // Exports (read)
  export_deposits: op("GET", "/api/v1/exports/deposits", "api_key", "read", "exports.deposits"),
  export_ledger: op("GET", "/api/v1/exports/ledger", "api_key", "read", "exports.ledger"),
  export_orders: op("GET", "/api/v1/exports/orders", "api_key", "read", "exports.orders"),
  export_trades: op("GET", "/api/v1/exports/trades", "api_key", "read", "exports.trades"),
  export_withdrawals: op("GET", "/api/v1/exports/withdrawals", "api_key", "read", "exports.withdrawals"),
  // Wallet (read)
  list_deposits: op("GET", "/api/v1/wallet/deposits", "api_key", "read", "wallet.deposits"),
  get_deposit: op("GET", "/api/v1/wallet/deposits/{deposit_id}", "api_key", "read", "wallet.deposit"),
  list_withdrawals: op("GET", "/api/v1/wallet/withdrawals", "api_key", "read", "wallet.withdrawals"),
  get_withdrawal: op("GET", "/api/v1/wallet/withdrawals/{withdrawal_id}", "api_key", "read", "wallet.withdrawal"),
  list_withdrawal_addresses: op("GET", "/api/v1/wallet/withdrawal-addresses", "api_key", "read", "wallet.withdrawalAddresses"),
  deposit_address: op("GET", "/api/v1/wallet/deposit-address", "api_key", "read", "wallet.depositAddress"),
  // Trading
  list_open_orders: op("GET", "/api/v1/trading/orders", "api_key", "read", "trading.openOrders"),
  get_order: op("GET", "/api/v1/trading/orders/{order_id}", "api_key", "read", "trading.order"),
  get_order_by_client_id: op("GET", "/api/v1/trading/orders/by-client-id/{client_order_id}", "api_key", "read", "trading.orderByClientId"),
  order_history: op("GET", "/api/v1/trading/orders/history", "api_key", "read", "trading.orderHistory"),
  trade_history: op("GET", "/api/v1/trading/trades", "api_key", "read", "trading.trades"),
  place_order: op("POST", "/api/v1/trading/orders", "api_key", "trade", "trading.placeOrder"),
  cancel_order: op("DELETE", "/api/v1/trading/orders/{order_id}", "api_key", "trade", "trading.cancelOrder"),
  cancel_all: op("POST", "/api/v1/trading/orders/cancel-all", "api_key", "trade", "trading.cancelAll"),
  cancel_all_after: op("POST", "/api/v1/trading/orders/cancel-all-after", "api_key", "trade", "trading.cancelAllAfter"),
  // Liquidity pools (trade)
  join_pool: op("POST", "/api/v1/pools/{symbol}/join", "api_key", "trade", "pools.join"),
  exit_pool: op("POST", "/api/v1/pools/{symbol}/exit", "api_key", "trade", "pools.exit"),
} as const satisfies Record<string, OperationInfo>;

export type OperationId = keyof typeof OPERATIONS;
