# @cexyio/cexy

The official TypeScript/JavaScript SDK for the [CEXY.io](https://cexy.io) REST and WebSocket API.

- Typed models generated from the public OpenAPI spec ([cexy-api-spec](https://github.com/cexyio/cexy-api-spec)).
- Safe by default: retries with backoff, order placement that never duplicates (via `client_order_id`), a client-side rate limiter.
- A WebSocket client with heartbeat, reconnect and a live order book that applies the sync rules for you.
- ESM and CommonJS, Node 22+, zero runtime dependencies.

> **Status: 0.x.** The API is not yet frozen. It stays 0.x until the exchange ships HMAC request signing,
> which will change how credentials are sent.
> Pre-release: `npm install @cexyio/cexy@next`; `latest` currently points at a pre-release until 1.0.

## Install

```bash
npm install @cexyio/cexy@next
# Node only, optional: lets the WebSocket client send a User-Agent
npm install ws
```

## Quick start: public data

```ts
import { CexyClient } from "@cexyio/cexy";

const cexy = new CexyClient(); // no key needed for market data

const markets = await cexy.markets.list();
const btc = await cexy.markets.get("BTC/USDT");
const book = await cexy.markets.orderbook("BTC/USDT", { depth: 10 });
const candles = await cexy.markets.candles("BTC/USDT", { interval: "1h", limit: 24 });
const { iso } = await cexy.time();
```

Also: `assets.list()/get()`, `networks.list()`, `fees.get()`, `config()`, `pools.list()/get()`, `markets.trades()`.

## Quick start: your account

```ts
import { CexyClient } from "@cexyio/cexy";

const cexy = new CexyClient({
  apiKey: process.env.CEXY_API_KEY,       // ak_your_key_here
  apiSecret: process.env.CEXY_API_SECRET, // your_secret_here
});

const balances = await cexy.account.balances();
const open = await cexy.trading.openOrders({ symbol: "BTC/USDT" });

const placed = await cexy.trading.placeOrder({
  symbol: "BTC/USDT",
  side: "buy",
  type: "limit",
  price: "60000.00",   // decimal STRINGS, never numbers
  quantity: "0.0010",
});
await cexy.trading.cancelOrder(placed.order.id);
await cexy.trading.cancelAll({ symbol: "BTC/USDT" }); // { symbol: null } = every market, explicitly
```

`cancelAll` requires `symbol`: the server treats a missing symbol as "every market", so the SDK makes
you say so with `{ symbol: null }`. An unknown symbol throws `NotFoundError`.

It also cancels stop orders that have not triggered yet (status `pending_trigger`) and releases
their reservations, so nothing fires into the market after the call.

One call handles at most 500 orders and puts each in exactly one list: `cancelled`, `already_closed`
(it filled, was refused or was cancelled elsewhere first; not an error) or `failed`, with the reason in
`failures` (`INVALID_STATE` for an order still being placed). `has_more: true` means more orders remain.
To let the SDK repeat the call for you:

```ts
const res = await cexy.trading.cancelAll({ symbol: null, untilDone: true });
// res.stopped: "done" | "max_rounds" | "time_budget"; res.rounds: calls made
if (res.stopped !== "done" || res.failed.length) console.warn("left over:", res.failures);
```

`untilDone` repeats while `has_more` is true or a failure is `INVALID_STATE` / `SERVICE_UNAVAILABLE`.
After a call without progress it waits 1, 2, 4, 8, then 15 s, and it stops after `maxRounds` calls
(default 20) or before a wait would pass `timeBudgetMs` (default 120 000). Every round is exactly one
request (the loop owns the retries, so it never sends more than `maxRounds` requests): a 429 round waits its
Retry-After, which counts against the budget; another retryable error (5xx, network) takes the next backoff
step; a wait that would pass the budget ends the loop with `stopped: "time_budget"` and `last_error_code`.
A wait imposed by the client rate limiter (e.g. `X-RateLimit-Remaining: 0` with a Reset) counts too: if it
would pass the budget the loop stops without calling, with `last_error_code: "RATE_LIMITED"`.
A non-retryable error (e.g. a key without the trade scope) throws `CancelAllInterruptedError` with the error
and the partial result. The server allows 30 cancel-all calls per minute per account.

Give both `apiKey` and `apiSecret`, or neither: passing only one throws at construction.

| Namespace | Methods | Scope |
|---|---|---|
| `markets` | `list`, `get`, `orderbook`, `trades`, `iterateTrades`, `candles` | public |
| `assets`, `networks`, `fees`, `pools` | `list`, `get` / `list` / `get` / `list`, `get` | public |
| `time()`, `config()` | | public |
| `account` | `balances`, `balance`, `ledger`, `notifications`, `subAccounts`, `apiKeys` (+ iterators) | read |
| `exports` | `deposits`, `ledger`, `orders`, `trades`, `withdrawals` (CSV text) | read |
| `wallet` | `deposits`, `deposit`, `withdrawals`, `withdrawal`, `withdrawalAddresses`, `depositAddress` (+ iterators) | read |
| `trading` | `openOrders`, `order`, `orderByClientId`, `orderHistory`, `trades` (+ iterators) | read |
| `trading` | `placeOrder`, `cancelOrder`, `cancelAll` | trade |
| `pools` | `join`, `exit` | trade |

`wallet.depositAddress({ asset, network })` **creates** the address on the first call for that
asset/network (later calls return the same one). Always use the `memo` too when one is returned.

There are no withdrawal or transfer methods: API keys cannot withdraw or transfer funds.

## Amounts

Every amount is an exact decimal **string** (`"0.00150000"`), in responses and requests. JS numbers are
binary floats and cannot hold most decimals exactly, so the SDK **rejects a `number` in any amount field
before sending** (`InvalidAmountError`). Do arithmetic with a decimal library, for example:

```ts
import Decimal from "decimal.js"; // or big.js, bignumber.js
const total = new Decimal(order.price!).times(order.quantity).toFixed();
```

`isAmount(value)` checks that a string is a plain decimal.

## Errors

Every API failure throws a `CexyApiError` (or a subclass) with `status`, `code`, `message`, `details`,
`fields`, `requestId` and `retryable`. Branch on `code`, never on `message`.

| Class | When |
|---|---|
| `AuthenticationError` | 401: missing or invalid credentials |
| `ForbiddenError` | 403: the key lacks a scope (`FORBIDDEN`), or the route is session-only (`API_KEY_NOT_ALLOWED`) |
| `JurisdictionBlockedError` | 451: `JURISDICTION_BLOCKED` (not available in the caller's jurisdiction); a `ForbiddenError` subclass |
| `ValidationError` | 400: see `fields` |
| `NotFoundError` | 404 |
| `ConflictError` | 409: `ALREADY_EXISTS`, `IDEMPOTENCY_KEY_CONFLICT`, `CONCURRENT_MODIFICATION` |
| `UnprocessableError` | 422: `INSUFFICIENT_FUNDS`, `MARKET_UNAVAILABLE`, ... |
| `RateLimitError` | 429, with `retryAfterMs` |
| `ServerError` | 5xx |
| `CexyApiError` | any code this SDK version does not know yet, and `UNEXPECTED_REDIRECT` (the server answered with a 3xx; set by the SDK, see `CLIENT_ERROR_CODES`) |

Local problems use `CexyConfigError`, `InvalidAmountError`, `CexyConnectionError` / `CexyTimeoutError`
and `OrderStateUnknownError`. `ErrorCode` is a union of the known codes plus `string`, because new codes
can appear: keep a default branch.

```ts
try {
  await cexy.trading.placeOrder(order);
} catch (err) {
  if (err instanceof CexyApiError && err.code === "INSUFFICIENT_FUNDS") console.log(err.details);
  else throw err;
}
```

## Retries and idempotency

- Timeout per attempt: `timeoutMs` (default 10 s). Retries: `maxRetries` (default 3), exponential backoff with full jitter.
- Retried: network errors, timeouts and responses with `retryable: true`.
- 429 waits at least `Retry-After` / `details.retry_after_seconds`. Server wait hints are untrusted: unusable
  values are ignored, and a hint longer than 120 s (`MAX_SERVER_WAIT_MS`) is never waited: the call fails at
  once with `RateLimitError`, whose `retryAfterMs` still has the server's value. The client-side rate limiter
  never blocks longer than 120 s because of a server hint.
- GETs retry freely.
- **Orders:** safety rests on `client_order_id`. The server does not honour `Idempotency-Key` on
  `POST /trading/orders`, order cancels or cancel-all, so the SDK does not send it there. `placeOrder` always sends a
  `client_order_id` (a UUID if you do not set one); it is unique per account and a repeat is refused
  before any funds move. After an ambiguous failure (network error, timeout, 5xx) the SDK first looks the
  order up by that id. If the order exists it is returned with `recovered: true`; only if it does not
  exist is it sent again, with the same id. If even the lookup fails you get `OrderStateUnknownError`:
  check `trading.orderByClientId()` before placing the order again.
- **Cancels:** `cancelOrder` retries network errors; if a *retry* gets `INVALID_STATE`, the first attempt
  already cancelled the order, so the SDK fetches and returns it. `cancelAll` is naturally repeatable and
  is retried the same way (a retry reports only what it cancelled).
- **Pool join/exit** are the only requests that send an `Idempotency-Key` (auto-generated, reused on every
  retry); the server honours it there, so they execute once. A 409 `CONCURRENT_MODIFICATION` (the same key
  still in flight) is retried with the same key. Pass `{ idempotencyKey }` to control it yourself.
- `onRetry` lets you log retries.

Every method takes a last `RequestOptions` argument: `{ signal, timeoutMs, maxRetries, idempotencyKey }`.

## Pagination

Histories use opaque cursors. Each listing returns one page (`items`, `has_more`, `next_cursor`), and has
an async iterator that fetches pages lazily:

```ts
for await (const order of cexy.trading.iterateOrderHistory({ symbol: "BTC/USDT", limit: 100 })) {
  console.log(order.id, order.status);
}
// cap the total: cexy.account.iterateLedger({}, { maxItems: 500 })
```

Each ledger entry's `reference` says what caused it, as a union told apart by `type` (`deposit`,
`withdrawal`, `order`, `trade`, `transfer`, `adjustment`, `pool`, `futures_transfer`, `system`).
Newer types the SDK does not know yet arrive unchanged instead of failing; narrow with
`isLedgerReference`:

```ts
import { isLedgerReference } from "@cexyio/cexy";

for await (const e of cexy.account.iterateLedger({}, { maxItems: 100 })) {
  if (isLedgerReference(e.reference, "trade")) console.log(e.reference.trade_id);
  else if (!isLedgerReference(e.reference)) console.log("new cause type:", e.reference.type);
}
```

Ids (`OrderId`, `TradeId`, `UserId`, …) are plain strings; the SDK does not check their format.

## Rate limits

The client has a token-bucket limiter: **100 requests/minute without a key** (the server allows 120/min
per IP for anonymous calls) and **300/minute with an API key** (the server allows 600/min per key once the
per-key limits are live). Cancel-all is limited separately to 30/min per account. It adapts
downwards to `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` (seconds until the window
resets), and pauses after a 429. Change it with `rateLimit: { requestsPerMinute }`, or turn it off with
`rateLimit: false`. The limiter is per client instance: share one client.

## WebSocket

```ts
const cexy = new CexyClient();
const ws = cexy.websocket(); // wss://api.cexy.io/api/v1/ws
await ws.connect();

ws.on("event", (e) => {
  if (e.type === "ticker.update") console.log(e.channel, e.data);
});
await ws.subscribe(["ticker:BTC/USDT", "trades:BTC/USDT"]);

const book = await ws.orderBook("BTC/USDT");
book.on("update", (b) => console.log(b.top.bid, b.top.ask, b.stale ? "stale" : ""));

ws.on("reconnected", () => console.log("reconnected and re-subscribed"));
ws.on("resync", () => {/* refetch anything you derive from events */});
```

What the client does for you:

- Sends `{"op":"ping"}` every 30 s (required: the server closes idle connections) and accepts the server's
  unsolicited pongs. No frame for 75 s means a dead connection and a reconnect.
- Reconnects with exponential backoff and full jitter, then re-authenticates and re-subscribes everything.
- Correlates every request with its acknowledgement by `id`: `auth` resolves on `authenticated`
  (and rejects on an `error` with its id, or on timeout), `subscribe` on `subscribed`, `unsubscribe` on
  `unsubscribed`, `ping()` on `pong`.
- Guards locally: at most 100 subscriptions (extras are returned in `refused`) and 200 messages/minute.
- Warns once if the server speaks a newer `protocol_version`, and ignores unknown event types.

**Order-book rules** (applied by `ws.orderBook()`; follow them if you build your own):

1. Subscribe to `orderbook:{symbol}` first, then take the REST snapshot (its `sequence` is S).
2. Drop updates with `sequence <= S`.
3. Every update carries the complete top 50 of both sides (`"full": true`) and replaces the previous state.
   There are no deltas. Never merge REST levels deeper than 50 into WebSocket state.
4. A sequence gap marks the book `stale` until the next update, which heals it. There is no forced resync.
5. Sequences reset when the server restarts: take a fresh snapshot after every reconnect.
6. An `error` frame `CONCURRENT_MODIFICATION` with a null `id` means messages were dropped: resync every book and channel (the client emits `resync`).

**Private channels** (`orders`, `balances`, `deposits`, `withdrawals`, `account`) need
`await ws.auth(token)` with a session access token (it resolves with the `user_id` from `authenticated`). **API-key authentication on the WebSocket is not available yet**: with an API key,
use public channels and poll REST for private state. If the session is revoked, the client emits
`authLost`; public channels keep working.

In Node the client uses the optional `ws` package when installed (so it can send the SDK User-Agent),
otherwise the global `WebSocket` (Node, browsers).

## Browsers

The SDK runs in browsers, but **never put API keys in a browser bundle**: anyone can read them. Call private
endpoints from a server. Browsers do not let scripts set `User-Agent`, so the SDK does not send one there.

## Security

- API keys **cannot withdraw or transfer funds**, whatever their scopes.
- Use a **read-only** key unless you need to trade, and restrict keys to your IPs (`allowed_ips`).
- Credentials go only in the `X-API-Key` / `X-API-Secret` headers and only on private endpoints; never in URLs.
- Only `https://` base URLs and `wss://` WebSocket URLs are accepted. `allowInsecure: true` permits
  `http://` / `ws://` solely for `localhost`, `127.0.0.1` or `::1` (local test servers).
- The SDK **never follows HTTP redirects**. A 3xx answer throws a `CexyApiError` with code
  `UNEXPECTED_REDIRECT` (not retried), so credentials are never re-sent to another host and an order
  is never re-posted to a redirect target. If you pass your own `fetch`, it must honour `redirect: "manual"`: one that follows redirects
  anyway has already sent your credentials by the time the SDK notices.
- The SDK redacts the secret from `toString()`, `util.inspect`, `JSON.stringify` and error messages.
- Keep keys in environment variables or a secret manager, not in code.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## For tool builders

The package exports its building blocks: the `OPERATIONS` table (method, path, auth and scope for each of the
40 operations), all model types, the error classes, `paginate()`, `RateLimiter`, the `Authenticator`
interface (HMAC signing will plug in here) and `userAgentSuffix` to identify your tool.

## Development

```bash
npm ci
npm run generate     # regenerate src/generated/schema.ts from ../cexy-api-spec/spec/openapi.sdk.json
npm run lint && npm run typecheck && npm test
npm run build
CEXY_LIVE_TESTS=1 npm run test:live   # optional: 3 anonymous GETs against api.cexy.io
```

Tests read the shared conformance cases from a `cexy-api-spec` checkout next to this repo
(override with `CEXY_API_SPEC_DIR`).

## License

MIT, see [LICENSE](LICENSE).
