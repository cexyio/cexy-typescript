import type { CexyClient, OperationId } from "../src/index.js";

/** How to call each operation through the public facade (used by coverage and auth tests). */
export const INVOKE: Record<OperationId, (c: CexyClient) => Promise<unknown>> = {
  server_time: (c) => c.time(),
  exchange_config: (c) => c.config(),
  list_fee_schedules: (c) => c.fees.get(),
  list_assets: (c) => c.assets.list(),
  get_asset: (c) => c.assets.get("BTC"),
  list_networks: (c) => c.networks.list(),
  list_markets: (c) => c.markets.list(),
  get_market: (c) => c.markets.get("BTC/USDT"),
  get_order_book: (c) => c.markets.orderbook("BTC/USDT", { depth: 10 }),
  get_market_trades: (c) => c.markets.trades("BTC/USDT", { limit: 5 }),
  get_candles: (c) => c.markets.candles("BTC/USDT", { interval: "1h" }),
  list_pools: (c) => c.pools.list(),
  get_pool: (c) => c.pools.get("BTC/USDT"),
  list_balances: (c) => c.account.balances(),
  get_balance: (c) => c.account.balance("BTC"),
  get_ledger: (c) => c.account.ledger({ limit: 5 }),
  list_notifications: (c) => c.account.notifications({ unread_only: true }),
  list_sub_accounts: (c) => c.account.subAccounts(),
  sub_account_balances: (c) => c.account.subAccountBalances("sub_1"),
  list_api_keys: (c) => c.account.apiKeys(),
  export_deposits: (c) => c.exports.deposits({ from: "2026-01-01T00:00:00Z" }),
  export_ledger: (c) => c.exports.ledger(),
  export_orders: (c) => c.exports.orders(),
  export_trades: (c) => c.exports.trades(),
  export_withdrawals: (c) => c.exports.withdrawals(),
  list_deposits: (c) => c.wallet.deposits(),
  get_deposit: (c) => c.wallet.deposit("dep_1"),
  list_withdrawals: (c) => c.wallet.withdrawals(),
  get_withdrawal: (c) => c.wallet.withdrawal("wd_1"),
  list_withdrawal_addresses: (c) => c.wallet.withdrawalAddresses(),
  deposit_address: (c) => c.wallet.depositAddress({ asset: "BTC", network: "bitcoin" }),
  list_open_orders: (c) => c.trading.openOrders({ symbol: "BTC/USDT" }),
  get_order: (c) => c.trading.order("ord_1"),
  get_order_by_client_id: (c) => c.trading.orderByClientId("cid_1"),
  order_history: (c) => c.trading.orderHistory({ limit: 10 }),
  trade_history: (c) => c.trading.trades(),
  place_order: (c) =>
    c.trading.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "limit", price: "60000.00", quantity: "0.001" }),
  cancel_order: (c) => c.trading.cancelOrder("ord_1"),
  cancel_all: (c) => c.trading.cancelAll({ symbol: "BTC/USDT" }),
  join_pool: (c) => c.pools.join("BTC/USDT", { base_amount: "0.1", quote_amount: "6000" }),
  exit_pool: (c) => c.pools.exit("BTC/USDT", { shares: "1.5" }),
};

/** Parses "GET /api/v1/markets" into an operation id using the table. */
export function opIdFor(operation: string, table: Record<string, { method: string; path: string }>): OperationId {
  const [method, path] = operation.split(" ");
  const hit = Object.entries(table).find(([, o]) => o.method === method && o.path === path);
  if (!hit) throw new Error(`unknown operation ${operation}`);
  return hit[0] as OperationId;
}
