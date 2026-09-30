# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Versions stay 0.x until the API ships request signing.

## [Unreleased]

## [0.1.0-dev.9] (2026-09-30)

### Added
- `account.id()`: the account id of the API key (`GET /api/v1/account/id`, read scope).
- `CexyWebSocket.liveBalances()` / `LiveBalances`: live balances from a REST snapshot plus
  `balance.updated` events. An event applies only when its `sequence` is greater than the stored
  one (a total of 0 removes the row, and an older snapshot row cannot bring it back); a refetch
  happens on a missed event, `balances.resync`, `CONCURRENT_MODIFICATION`, a reconnect or an
  account change, at most every `minSnapshotIntervalMs` (default 2 s), with retry backoff. Before
  every merge the REST key's account (`account.id()`) must be the WebSocket's user, otherwise
  nothing is merged (`AccountMismatchError`, `ACCOUNT_MISMATCH`). Events without `sequence` (older
  servers) always apply and log one warning. `stale`, `lastError`, `get()`, `all()`, `close()`;
  events `update`, `snapshot`, `error`.
- WebSocket: frame-sequence tracking on private channels. A gap that is not filled within
  `reorderWindowMs` (default 250 ms; channels with several publishers can swap adjacent frames)
  emits `sequenceGap` and `resync` `"sequence_gap"`. The first frame after `subscribed` is the
  baseline; sequences reset on reconnect, re-subscribe and account change.
- WebSocket: `balances.resync` (and the planned `deposits.resync` / `withdrawals.resync`) are known
  events and emit `resync` with `"balances_resync"`, `"deposits_resync"` or `"withdrawals_resync"`.
- WebSocket: the planned `signed_out` server frame is handled as a server sign-out: `expired` gives
  `authChanged` `token_expired`, `revoked` gives `session_revoked` plus `authLost` (synthetic
  `session.revoked` event with `data.reason: "signed_out"`), any other reason gives `signed_out`
  with the raw reason in `code`. The token is forgotten; private channels come back after the next
  successful `auth()`.
- `Balance.sequence` (a missing value decodes as 0), `BalanceUpdatedData`, `CexyWebSocket.userId`,
  `WsClock` / `clock` (test-only time source), `REAL_CLOCK`.

### Changed
- `AuthChangeReason` gains `token_expired` and `signed_out`; `ResyncReason` gains `sequence_gap`,
  `balances_resync`, `deposits_resync` and `withdrawals_resync`. Both unions may grow.

### Security
- Dev dependency: `esbuild` is forced to `^0.28.1` through `overrides` (tsup 8.5.1 still asks for
  `^0.27`). This fixes a low-severity advisory in esbuild's development server on Windows, which
  this project does not use. The published build is byte-identical with 0.27.7 and 0.28.2, so no
  release is needed for it.

## [0.1.0-dev.8] (2026-09-30)

### Fixed
- WebSocket: private channels no longer go silent after a server-side sign-out. The server ends
  every private subscription (without a frame) when `auth()` succeeds as another user, when an
  `auth()` fails, or when this connection's own session is revoked. The client used to keep
  those channels as held, so `subscribe()` for them sent nothing. It now drops them, emits the
  new `authChanged` event (`reason`, `previousUserId`, `userId`, `code`, `dropped`) and
  re-subscribes them: at once after a switch to another user, after the next successful
  `auth()` otherwise, followed by `resync` with the new reason `"reauth"`. Re-authenticating
  as the same user changes nothing.
- WebSocket: a `subscribe()` refused by the server (e.g. `UNAUTHENTICATED` for a private
  channel) no longer leaves the channels in `channels`.

### Changed
- WebSocket: `session.revoked` with `current: false` (another session of the same account was
  revoked) no longer emits `authLost`, drops private channels or forgets the token; the server
  keeps this connection signed in. Only `current: true` does. **Behaviour change.**

### Added
- `CexyWebSocket.hasToken`: whether a session token is kept for automatic re-authentication.
- Types `AuthChange`, `AuthChangeReason`; `ResyncReason` gains `"reauth"`.
- Conformance: runs `cexy-api-spec/conformance/ws/private_signout.json` against a scripted server.

## [0.1.0-dev.7] (2026-09-29)

### Added
- `account.subAccountBalances(id)`: a sub-account's balances, read by its parent account
  (`GET /account/sub-accounts/{id}/balances`, read scope). Same shape as `balances()`, including
  `held_incoming`. An id that is not the caller's sub-account gives `NotFoundError` (not retried).
- `Balance.held_incoming` (and the `HeldIncoming` type): incoming internal transfers still held,
  `{ transfer_id, amount, available_at }`, at most 100, soonest first. Their sum is already included
  in `locked`: never add it again. `balances()` and `balance()` always return an array (`[]` when the
  server omits the field).

### Changed
- A 4xx response is never retried except 429 and 409 `CONCURRENT_MODIFICATION`, even when its body
  says `retryable: true`. A 408 is no longer retried either, and its default `retryable` (no field in
  the body) is now false. 409 `CONCURRENT_MODIFICATION` and 429
  are still retried only where they were before. A mutation sent through the shared retry loop is
  retried only when it is repeat-safe (pool join/exit with their `Idempotency-Key`, cancel-all);
  `placeOrder` and `cancelOrder` keep their own policies.

### Security
- Path values `"."` and `".."` are rejected with `CexyConfigError`: previously they escaped their URL
  segment, so e.g. `subAccountBalances("..")` returned the parent's own balances and
  `orderByClientId("..")` the open-orders list. A write request could only be redirected to a route
  that does not exist and is refused by the server; no write could reach a different operation.

## [0.1.0-dev.6] (2026-09-28)

Synced with the API's H-1 release (spec in cexy-api-spec at fc3ce5c).

### Added
- `LedgerEntry.reference` is typed: `LedgerReference`, a union told apart by `type` (`deposit`,
  `withdrawal`, `order`, `trade`, `transfer`, `adjustment`, `pool`, `futures_transfer`, `system`). Newer
  types the SDK does not know yet arrive unchanged as `UnknownLedgerReference` instead of failing. Narrow
  with the new `isLedgerReference(ref)` / `isLedgerReference(ref, "trade")`.
- Id types `DepositId`, `FuturesTransferId`, `OrderId`, `PoolId`, `TradeId`, `UserId`, `WithdrawalId`:
  plain strings, not format-checked.
- Error code `PRICE_UNAVAILABLE` (422, `UnprocessableError`); withdrawal status `reverted` (a transaction
  that failed on chain, refunded by the exchange); five new `LedgerEntryKind` values for held and
  reversed transfers and withdrawal refunds.

### Changed
- `cancelAll` docs: the server now also cancels stop orders that have not triggered yet
  (`pending_trigger`) and releases their reservations.
- `JoinPoolRequest.max_ratio_deviation_percent` is typed as an amount (it was already validated as one).

### Fixed
- `cancelAll({ untilDone: true })` counts the client rate limiter's pending wait against its time budget.
  A successful round with `X-RateLimit-Remaining: 0` and a long `X-RateLimit-Reset` made the limiter hold
  the next round inside the request, invisibly to the loop, so it could run past the budget (e.g. 170 s
  against 120 s). If the limiter's wait would reach the budget, the loop now stops before calling, with
  `stopped: "time_budget"` and `last_error_code: "RATE_LIMITED"`. New `RateLimiter.pendingWaitMs()`.

### CI
- New `consumer` job, also run in the publish build job: the package is built and packed as users get it,
  installed into an empty project without dev dependencies, and smoke-tested through ESM `import` and CJS
  `require` (`ci/consumer/`, not part of the published package). A live `time()` call runs only with
  `CEXY_LIVE_TESTS=1`.

## [0.1.0-dev.5]

### Fixed
- **Server-controlled waits are bounded.** `Retry-After`, `details.retry_after_seconds` and
  `X-RateLimit-Reset` are treated as untrusted: unparseable, negative or non-finite values are ignored, a
  hint longer than 120 s (`MAX_SERVER_WAIT_MS`, exported) is never waited (the call fails at once with
  `RateLimitError`, which still carries the server's value), and the client-side rate limiter never blocks
  longer than 120 s or adopts a limit below one request a minute. Before, a `Retry-After: 86400` stalled
  the call and the shared limiter for a day.
- **`cancelAll({ untilDone: true })` owns its retries.** Each round is exactly one request, so the loop
  never sends more than `maxRounds` requests (before, each round could retry 3 times). A 429 round waits
  its Retry-After exactly, other retryable errors take the next backoff step, and a wait past
  `timeBudgetMs` is not taken: the loop stops with `stopped: "time_budget"` and the new
  `last_error_code`. A non-retryable error throws the new `CancelAllInterruptedError`, which carries the
  error and the partial result.

### Changed
- `Idempotency-Key` is sent only on pool join/exit, where the server honours it. Orders, cancels and
  cancel-all no longer send it (the server ignored it there); their safety is unchanged
  (`client_order_id` and the cancel rules).


## [0.1.0-dev.4]

### Added
- `cancelAll` returns the full cancel-all v2 response: `already_closed` (closed on its own; not an
  error), `failures` (`order_id`, `code`, `message` for each order in `failed`) and `has_more`
  (more than the 500 orders one call handles).
- `cancelAll({ ..., untilDone: true })` repeats the call until nothing is left to retry, with backoff,
  `maxRounds` (default 20) and `timeBudgetMs` (default 120000). It returns the merged result plus
  `rounds` and `stopped`. Types `CancelAllUntilDoneResult`, `CancelAllStopReason`, `CancelFailure`.
- Types generated from the updated spec: `cancel_all` declares 404 (unknown symbol) and 429 (30 calls
  a minute per account).
- `CLIENT_ERROR_CODES` (currently `UNEXPECTED_REDIRECT`): codes the SDK sets itself, which the API never
  sends.

### Changed
- Docs: a custom `fetch` must honour `redirect: "manual"` (JSDoc on the `fetch` option and README).
- CI: every checkout uses `persist-credentials: false`.

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
