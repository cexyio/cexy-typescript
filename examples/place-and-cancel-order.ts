/**
 * WARNING: THIS PLACES A REAL ORDER on your CEXY.io account with real funds.
 * It needs an API key with the `trade` scope. Orders are irreversible once filled.
 *
 * It places a small post-only limit buy far below the market (so it should rest, not fill),
 * then cancels it. Run it only if you understand and accept that.
 *
 *   CEXY_API_KEY=ak_your_key_here CEXY_API_SECRET=your_secret_here \
 *   CEXY_CONFIRM_REAL_ORDER=yes npx tsx examples/place-and-cancel-order.ts
 */
import { CexyClient, OrderStateUnknownError, UnprocessableError } from "@cexyio/cexy";

if (process.env.CEXY_CONFIRM_REAL_ORDER !== "yes") {
  console.error("Refusing to run: set CEXY_CONFIRM_REAL_ORDER=yes to place a REAL order.");
  process.exit(1);
}

const cexy = new CexyClient({ apiKey: process.env.CEXY_API_KEY, apiSecret: process.env.CEXY_API_SECRET });
const symbol = "BTC/USDT";
const market = await cexy.markets.get(symbol);

// Prices and quantities are decimal STRINGS. A JS number is rejected before sending.
// Here: a price at the market's minimum tick, and the minimum quantity.
const order = {
  symbol,
  side: "buy" as const,
  type: "limit" as const,
  time_in_force: "post_only" as const,
  price: market.tick_size,
  quantity: market.min_quantity,
};

try {
  // The SDK sets a client_order_id (UUID; unique per account, so the server refuses a repeat)
  // and after an ambiguous failure looks the order up by it before retrying, so the order is
  // never placed twice.
  const placed = await cexy.trading.placeOrder(order);
  console.log("placed", placed.order.id, placed.order.status, "client id", placed.client_order_id);

  const cancelled = await cexy.trading.cancelOrder(placed.order.id);
  console.log("cancelled", cancelled.id, cancelled.status);
} catch (err) {
  if (err instanceof OrderStateUnknownError) {
    console.error(`unknown state; check trading.orderByClientId("${err.clientOrderId}")`);
  } else if (err instanceof UnprocessableError) {
    console.error(`refused: ${err.code} ${err.message}`, err.details);
  } else throw err;
}
