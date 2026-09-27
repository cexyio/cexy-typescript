# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Versions stay 0.x until the API ships request signing.

## [Unreleased]

## [0.1.0-dev.3]

### Security
- **Redirects are no longer followed.** Earlier versions called `fetch` with the default
  `redirect: "follow"`. Fetch strips only `Authorization` on a cross-origin redirect, so a 3xx from the
  API host (or anything between you and it) re-sent `X-API-Key` and `X-API-Secret` to the redirect
  target, over plain `http://` as well. A 307/308 on `placeOrder` also re-posted the order. Requests
  now use `redirect: "manual"`, and a 3xx (or a response a custom `fetch` followed anyway) throws
  `CexyApiError` with code `UNEXPECTED_REDIRECT`, which is not retried. Upgrade from 0.1.0-dev.2 or
  earlier.

### Changed
- **Breaking: requires Node.js 22 or newer** (`engines` `>=22`). Node 20 reached end-of-life in April 2026.
  CI tests Node 22, 24 and 26.
- Build target `node22` (was `node20`).

## [0.1.0-dev.2]

First release published by CI through npm trusted publishing, with provenance. Same code as
0.1.0-dev.1.

### Fixed
- Publish workflow: the tarball path is `./pkg/*.tgz`, because npm reads `pkg/x.tgz` as a GitHub
  `user/repo` shorthand. The build job now dry-runs the exact publish command before the
  environment approval.

## [0.1.0-dev.1] (tagged, not published)

The CI publish failed before upload (the path problem above); nothing reached npm.

### Added
- `JurisdictionBlockedError` (a `ForbiddenError` subclass) for `JURISDICTION_BLOCKED` / HTTP 451.

### Changed
- README: pre-releases install with `npm install @cexyio/cexy@next`; `latest` points at a
  pre-release until 1.0.

## [0.1.0-dev.0] (2026-09-27)

First published pre-release (manual bootstrap upload of the CI-built tarball; no provenance).

- Requires Node.js 20 or newer (Node 18 is end-of-life and lacks the global `crypto.randomUUID`).

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
