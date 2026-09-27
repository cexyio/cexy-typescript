import { describe, expect, it } from "vitest";
import {
  CexyConnectionError,
  CexyTimeoutError,
  ConflictError,
  OrderStateUnknownError,
  ValidationError,
} from "../src/index.js";
import { json, networkError, ok, order, testClient } from "./helpers.js";

const svc = (retryable = true) => json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "busy", retryable } });
const notFound = () => json(404, { error: { code: "NOT_FOUND", message: "no such order", retryable: false } });
const req = { symbol: "BTC/USDT", side: "buy", type: "limit", price: "60000.00", quantity: "0.001" } as const;

describe("GET retries", () => {
  it("retries retryable errors and network failures with backoff, then succeeds", async () => {
    const { client, calls, sleeps } = testClient({ replies: [svc(), networkError()], fallback: ok([]) });
    await client.markets.list();
    expect(calls.length).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!); // exponential
  });

  it("gives up after maxRetries", async () => {
    const { client, calls } = testClient({ fallback: () => networkError(), maxRetries: 2 });
    await expect(client.markets.list()).rejects.toBeInstanceOf(CexyConnectionError);
    expect(calls.length).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    const { client, calls } = testClient({ replies: [json(400, { error: { code: "VALIDATION_FAILED", message: "x", retryable: false } })] });
    await expect(client.markets.list()).rejects.toBeInstanceOf(ValidationError);
    expect(calls.length).toBe(1);
  });

  it("times out an attempt with CexyTimeoutError", async () => {
    // Use a real fetch mock that respects the abort signal.
    const { CexyClient } = await import("../src/index.js");
    const client = new CexyClient({
      fetch: (_u, init) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
      timeoutMs: 20,
      maxRetries: 0,
      rateLimit: false,
    });
    await expect(client.time()).rejects.toBeInstanceOf(CexyTimeoutError);
  });

  it("caller abort stops without retrying", async () => {
    const ac = new AbortController();
    const { client, calls } = testClient({
      fallback: () => {
        ac.abort(new Error("stop"));
        return networkError();
      },
    });
    await expect(client.markets.list({ signal: ac.signal })).rejects.toThrow("stop");
    expect(calls.length).toBe(1);
  });
});

describe("mutations", () => {
  it("pool join sends an auto Idempotency-Key and reuses it on retry after a network error", async () => {
    const { client, calls } = testClient({ replies: [networkError()], fallback: ok({}) });
    await client.pools.join("BTC/USDT", { base_amount: "1", quote_amount: "2" });
    expect(calls.length).toBe(2);
    expect(calls[0]!.headers.get("Idempotency-Key")).toBeTruthy();
    expect(calls[0]!.headers.get("Idempotency-Key")).toBe(calls[1]!.headers.get("Idempotency-Key"));
  });

  it("orders, cancels and cancel-all send no Idempotency-Key (the server does not honour it there)", async () => {
    const { client, calls } = testClient({
      replies: [networkError(), ok(order({ status: "cancelled" })), ok({ order: order(), fills: [] })],
      fallback: ok({ cancelled: [], already_closed: [], failed: [], failures: [], has_more: false }),
    });
    await client.trading.cancelOrder("ord_1", { idempotencyKey: "ignored" });
    await client.trading.placeOrder(req);
    await client.trading.cancelAll({ symbol: "BTC/USDT" });
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "DELETE", "POST", "POST"]);
    for (const c of calls) expect(c.headers.has("Idempotency-Key")).toBe(false);
  });

  it("use the caller's Idempotency-Key when given", async () => {
    const { client, calls } = testClient({ fallback: ok({}) });
    await client.pools.exit("BTC/USDT", { shares: "1" }, { idempotencyKey: "my-key-1" });
    expect(calls[0]!.headers.get("Idempotency-Key")).toBe("my-key-1");
  });

  it("GETs carry no Idempotency-Key", async () => {
    const { client, calls } = testClient({ fallback: ok([]) });
    await client.markets.list();
    expect(calls[0]!.headers.has("Idempotency-Key")).toBe(false);
  });

  it("IDEMPOTENCY_KEY_CONFLICT is not retried", async () => {
    const { client, calls } = testClient({
      replies: [json(409, { error: { code: "IDEMPOTENCY_KEY_CONFLICT", message: "different body", retryable: false } })],
    });
    await expect(client.pools.join("BTC/USDT", { base_amount: "1", quote_amount: "2" })).rejects.toBeInstanceOf(ConflictError);
    expect(calls.length).toBe(1);
  });

  it("cancelAll requires an explicit symbol; null (explicit) means every market", async () => {
    const { client, calls } = testClient({ fallback: ok({ cancelled: [], failed: [] }) });
    // @ts-expect-error - symbol is required
    await expect(client.trading.cancelAll({})).rejects.toThrow(/symbol/);
    // @ts-expect-error - params are required
    await expect(client.trading.cancelAll()).rejects.toThrow(/symbol/);
    // @ts-expect-error - undefined is not null
    await expect(client.trading.cancelAll({ symbol: undefined })).rejects.toThrow(/symbol/);
    await expect(client.trading.cancelAll({ symbol: "" })).rejects.toThrow(/symbol/);
    expect(calls.length).toBe(0);
    await client.trading.cancelAll({ symbol: null });
    expect(calls[0]!.body).toEqual({});
    await client.trading.cancelAll({ symbol: "ETH/USDT" });
    expect(calls[1]!.body).toEqual({ symbol: "ETH/USDT" });
  });
});

describe("cancelOrder", () => {
  const invalidState = () => json(409, { error: { code: "INVALID_STATE", message: "order is not open", retryable: false } });

  it("INVALID_STATE on a retry means the first attempt cancelled it: fetch and return the order", async () => {
    const { client, calls } = testClient({
      replies: [networkError(), invalidState(), ok(order({ id: "ord_5", status: "cancelled" }))],
    });
    const o = await client.trading.cancelOrder("ord_5");
    expect(o.status).toBe("cancelled");
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "DELETE /api/v1/trading/orders/ord_5",
      "DELETE /api/v1/trading/orders/ord_5",
      "GET /api/v1/trading/orders/ord_5",
    ]);
  });

  it("INVALID_STATE on the first attempt is thrown (e.g. already filled)", async () => {
    const { client, calls } = testClient({ replies: [invalidState()] });
    await expect(client.trading.cancelOrder("ord_6")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(calls.length).toBe(1);
  });
});

describe("placeOrder retry safety", () => {
  it("auto-generates a UUID client_order_id when absent and keeps the caller's otherwise", async () => {
    const { client, calls } = testClient({ fallback: ok({ order: order(), fills: [] }) });
    const r1 = await client.trading.placeOrder(req);
    expect(calls[0]!.body.client_order_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(r1.client_order_id).toBe(calls[0]!.body.client_order_id);
    await client.trading.placeOrder({ ...req, client_order_id: "mine-1" });
    expect(calls[1]!.body.client_order_id).toBe("mine-1");
    expect(calls[0]!.headers.has("Idempotency-Key")).toBe(false);
  });

  it("after an ambiguous failure, finds the order by client id and does NOT resend", async () => {
    const { client, calls } = testClient({
      replies: [networkError(), (r) => ok(order({ client_order_id: r.url.pathname.split("/").pop() }))],
    });
    const res = await client.trading.placeOrder({ ...req, client_order_id: "cid-42" });
    expect(res.recovered).toBe(true);
    expect(res.order.client_order_id).toBe("cid-42");
    expect(res.fills).toEqual([]);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /api/v1/trading/orders",
      "GET /api/v1/trading/orders/by-client-id/cid-42",
    ]);
  });

  it("after an ambiguous 5xx, resends only when the lookup says the order does not exist", async () => {
    const { client, calls } = testClient({
      replies: [svc(), notFound(), ok({ order: order(), fills: [] })],
    });
    const res = await client.trading.placeOrder(req);
    expect(res.recovered).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
    expect(calls[0]!.body.client_order_id).toBe(calls[2]!.body.client_order_id);
    expect(calls[2]!.headers.has("Idempotency-Key")).toBe(false);
  });

  it("throws OrderStateUnknownError when the lookup fails too", async () => {
    const { client, calls } = testClient({ fallback: () => networkError(), maxRetries: 1 });
    const err = await client.trading.placeOrder({ ...req, client_order_id: "cid-7" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderStateUnknownError);
    expect((err as OrderStateUnknownError).clientOrderId).toBe("cid-7");
    // 1 POST, then the lookup (GET with its own retries); no second POST.
    expect(calls.filter((c) => c.method === "POST").length).toBe(1);
  });

  it("a duplicate client id reported on a retry resolves to the existing order", async () => {
    const { client, calls } = testClient({
      replies: [
        json(429, { error: { code: "RATE_LIMITED", message: "slow", retryable: true } }, { "Retry-After": "1" }),
        json(409, { error: { code: "ALREADY_EXISTS", message: "client order id in use", retryable: false } }),
        ok(order({ client_order_id: "cid-9" })),
      ],
    });
    const res = await client.trading.placeOrder({ ...req, client_order_id: "cid-9" });
    expect(res.recovered).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "GET"]);
  });

  it("a duplicate client id on the FIRST attempt is the caller's error", async () => {
    const { client } = testClient({
      replies: [json(409, { error: { code: "ALREADY_EXISTS", message: "client order id in use", retryable: false } })],
    });
    await expect(client.trading.placeOrder({ ...req, client_order_id: "reused" })).rejects.toBeInstanceOf(ConflictError);
  });
});
