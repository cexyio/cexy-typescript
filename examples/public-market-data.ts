/**
 * Public market data: no API key needed.
 *   npx tsx examples/public-market-data.ts
 */
import { CexyClient } from "@cexyio/cexy";

const cexy = new CexyClient();

const time = await cexy.time();
console.log("server time", time.iso);

const markets = await cexy.markets.list();
for (const m of markets.slice(0, 5)) {
  // Amounts are decimal strings. Use a decimal library for arithmetic, never Number().
  console.log(m.symbol, m.status, "last", m.last_price, "bid", m.best_bid, "ask", m.best_ask);
}

const symbol = markets[0]?.symbol ?? "BTC/USDT";
const book = await cexy.markets.orderbook(symbol, { depth: 5 });
console.log(`${symbol} book @ sequence ${book.sequence}`, { bids: book.bids, asks: book.asks });

const candles = await cexy.markets.candles(symbol, { interval: "1h", limit: 3 });
console.log("candles", candles);

// Live order book over the WebSocket (the helper applies the sync rules for you).
const ws = cexy.websocket();
await ws.connect();
const live = await ws.orderBook(symbol);
live.on("update", (b) => console.log("best bid/ask", b.top.bid, b.top.ask, b.stale ? "(stale)" : ""));
setTimeout(() => ws.close(), 10_000);
