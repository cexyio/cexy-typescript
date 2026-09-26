# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Versions stay 0.x until the API ships request signing.

## [Unreleased]

### Changed
- Order safety is documented as resting on `client_order_id`; the server does not honour
  `Idempotency-Key` on order placement, order cancels or cancel-all (pool join/exit only).
- `cancelOrder`: `INVALID_STATE` on a retry is treated as already cancelled and the order is returned.
- WebSocket requests are correlated with their acknowledgements by id. `auth()` now returns a promise
  that resolves on `authenticated` and rejects on an error or timeout; `unsubscribe()` waits for
  `unsubscribed`.

### Security
- `baseUrl` must be `https://` and WebSocket URLs `wss://`; `allowInsecure: true` allows plain text
  only for loopback hosts.

### Added
- `allowInsecure` option on `CexyClient` and `CexyWebSocket`; `isLocalHost()`.
- `CexyWebSocket.ping()`, `authenticated` / `unsubscribed` events, `AuthResult`,
  `CexyWebSocketError.fromServer`.

## [0.1.0-dev.0]

First development prototype. Not published.

### Added
- `CexyClient` covering the 40 operations of the SDK surface: public market data, account, exports,
  wallet reads, trading and liquidity pools.
- Types generated from `spec/openapi.sdk.json` (spec `info.version` 1.0.0), with amounts as decimal
  strings; numbers in amount fields are rejected before sending.
- Error classes mapped from the API error envelope, including `ForbiddenError` for `API_KEY_NOT_ALLOWED`.
- Retries with exponential backoff and jitter, `Retry-After` handling, idempotency keys, and
  duplicate-safe `placeOrder` (client order id lookup after an ambiguous failure).
- Client-side rate limiter (100/min anonymous, 300/min with a key) that adapts to `X-RateLimit-*`.
- Cursor pagination with async iterators.
- `CexyWebSocket`: heartbeat, liveness, local limits, reconnect with re-auth and re-subscribe, and
  `LiveOrderBook` implementing the order-book sync rules.
- `Authenticator` interface so request signing can be added without breaking callers.
