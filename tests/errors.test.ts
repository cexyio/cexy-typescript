import { describe, expect, it } from "vitest";
import {
  CexyApiError,
  ConflictError,
  ForbiddenError,
  JurisdictionBlockedError,
  NotFoundError,
  RateLimitError,
  ServerError,
  UnprocessableError,
  ValidationError,
  errorFromResponse,
  isKnownErrorCode,
} from "../src/index.js";
import { json, loadJson, ok, testClient } from "./helpers.js";

const fixture = (name: string) => loadJson<any>(`conformance/errors/${name}.json`);
const reply = (f: any) => json(f.status, f.body, f.headers ?? {});

describe("conformance/errors fixtures", () => {
  it("rate_limited: retries after waiting at least Retry-After / retry_after_seconds", async () => {
    const f = fixture("rate_limited");
    const { client, calls, sleeps } = testClient({ replies: [reply(f)], fallback: ok({ iso: "x", epoch_ms: 1 }) });
    const t = await client.time();
    expect(t.epoch_ms).toBe(1);
    expect(calls.length).toBe(2);
    expect(f.expect.retry).toBe(true);
    expect(sleeps[0]).toBeGreaterThanOrEqual(f.expect.wait_seconds_at_least * 1000);
  });

  it("rate_limited: surfaces RateLimitError with retryAfterMs when retries are exhausted", async () => {
    const f = fixture("rate_limited");
    const { client } = testClient({ replies: [reply(f)], maxRetries: 0 });
    const err = await client.time().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(2000);
    expect((err as RateLimitError).requestId).toBe("req_test_1");
    expect((err as RateLimitError).retryable).toBe(true);
  });

  it("idempotency_in_flight: 409 CONCURRENT_MODIFICATION retried with the SAME Idempotency-Key (pool join)", async () => {
    const f = fixture("idempotency_in_flight");
    const { client, calls, sleeps } = testClient({
      replies: [reply(f), reply(f)],
      fallback: ok({ shares: "1" }),
    });
    await client.pools.join("BTC/USDT", { base_amount: "0.1", quote_amount: "6000" });
    expect(calls.length).toBe(3);
    const keys = calls.map((c) => c.headers.get("Idempotency-Key"));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(1);
    expect(f.expect.same_idempotency_key).toBe(true);
    expect(sleeps.every((s) => s >= 2000)).toBe(true); // honours details.retry_after_seconds
  });

  it("placeOrder retries a retryable refusal with the same client_order_id (its real safety)", async () => {
    const f = fixture("idempotency_in_flight");
    const { client, calls } = testClient({ replies: [reply(f)], fallback: ok({ order: { id: "o1" }, fills: [] }) });
    const res = await client.trading.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", quantity: "0.01" });
    expect(res.recovered).toBe(false);
    expect(calls.length).toBe(2);
    expect(calls[0]!.headers.get("Idempotency-Key")).toBe(calls[1]!.headers.get("Idempotency-Key"));
    expect(calls[0]!.body.client_order_id).toBe(calls[1]!.body.client_order_id);
  });

  it("unknown_code: maps to the base CexyApiError without crashing", async () => {
    const f = fixture("unknown_code");
    const { client, calls } = testClient({ replies: [reply(f)] });
    const err = await client.markets.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CexyApiError);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect((err as CexyApiError).constructor).toBe(CexyApiError);
    expect((err as CexyApiError).code).toBe(f.expect.error_code);
    expect(isKnownErrorCode((err as CexyApiError).code)).toBe(false);
    expect(calls.length).toBe(1);
  });

  it("insufficient_funds: no retry, details kept", async () => {
    const f = fixture("insufficient_funds");
    const { client, calls } = testClient({ replies: [reply(f)] });
    const err = await client.trading
      .placeOrder({ symbol: "BTC/USDT", side: "buy", type: "limit", price: "1", quantity: "1.5" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableError);
    expect((err as CexyApiError).code).toBe(f.expect.error_code);
    expect((err as CexyApiError).details).toEqual(f.expect.details);
    expect((err as CexyApiError).requestId).toBe("req_test_2");
    expect(calls.length).toBe(1);
  });
});

describe("error mapping", () => {
  const env = (code: string, retryable = false) => ({ error: { code, message: code, retryable } });
  it.each([
    [400, "VALIDATION_FAILED", ValidationError],
    [404, "NOT_FOUND", NotFoundError],
    [409, "ALREADY_EXISTS", ConflictError],
    [409, "IDEMPOTENCY_KEY_CONFLICT", ConflictError],
    [422, "MARKET_UNAVAILABLE", UnprocessableError],
    [422, "PRICE_UNAVAILABLE", UnprocessableError],
    [503, "UNDER_MAINTENANCE", ServerError],
    [429, "RATE_LIMITED", RateLimitError],
  ])("%i %s", (status, code, cls) => {
    expect(errorFromResponse(status, env(code))).toBeInstanceOf(cls);
  });

  it("non-envelope bodies map by status", () => {
    const e = errorFromResponse(502, "<html>bad gateway</html>");
    expect(e).toBeInstanceOf(ServerError);
    expect(e.code).toBe("HTTP_502");
    expect(e.retryable).toBe(true);
  });

  it("validation fields are exposed", () => {
    const e = errorFromResponse(400, { error: { code: "VALIDATION_FAILED", message: "bad", fields: { price: "too many decimals" }, retryable: false } });
    expect(e.fields).toEqual({ price: "too many decimals" });
  });
});

describe("known error codes", () => {
  it("matches every code in the spec's ErrorCode enum", () => {
    const spec = loadJson<{ components: { schemas: { ErrorCode: { enum: string[] } } } }>("spec/openapi.sdk.json");
    const codes = spec.components.schemas.ErrorCode.enum;
    expect(codes.length).toBeGreaterThan(40);
    expect(codes.filter((c) => !isKnownErrorCode(c))).toEqual([]);
  });

  it("maps JURISDICTION_BLOCKED (HTTP 451) to ForbiddenError", () => {
    const err = errorFromResponse(451, { error: { code: "JURISDICTION_BLOCKED", message: "x", retryable: false } });
    expect(err).toBeInstanceOf(JurisdictionBlockedError);
    expect(err).toBeInstanceOf(ForbiddenError); // existing ForbiddenError checks still match
    expect(err.retryable).toBe(false);
  });
});
