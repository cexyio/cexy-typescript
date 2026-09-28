import { describe, expect, it } from "vitest";
import { CancelAllInterruptedError, CexyClient, ForbiddenError, NotFoundError } from "../src/index.js";
import { json, loadJson, mockFetch, ok, TEST_KEY, TEST_SECRET, type Reply } from "./helpers.js";

interface Case {
  id: string;
  options?: { max_rounds?: number; time_budget_s?: number };
  responses_repeat_last?: boolean;
  responses: Record<string, unknown>[];
  expect: {
    calls: number;
    sleeps_s: number[];
    stopped?: string;
    cancelled?: string[];
    already_closed?: string[];
    failed?: string[];
    failure_codes?: Record<string, string>;
    last_error_code?: string;
    error_code?: string;
    partial_cancelled?: string[];
  };
}

const conformance = loadJson<{ cases: Case[] }>("conformance/trading/cancel_all_until_done.json");

/** A client on a fake clock: calls take no time, and every sleep (loop or transport) advances it. */
function clockedClient(replies: Reply[], fallback?: Reply, rateLimit: { requestsPerMinute: number } | false = false) {
  const m = mockFetch(replies, fallback);
  let t = 1_000_000;
  const sleeps: number[] = [];
  const client = new CexyClient({
    apiKey: TEST_KEY,
    apiSecret: TEST_SECRET,
    fetch: m.fetch,
    rateLimit,
    random: () => 0.5,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { client, calls: m.calls, sleeps, elapsed: () => t - 1_000_000 };
}

const round = (data: Record<string, unknown>) => ok({ failures: [], ...data });
const pending = (ids: string[], code = "INVALID_STATE") => ({
  cancelled: [],
  already_closed: [],
  failed: ids,
  has_more: false,
  failures: ids.map((order_id) => ({ order_id, code, message: "still being placed" })),
});

/** A conformance response item: a `data` object (200), or an error with `http_status`. */
function reply(r: Record<string, unknown>): Response {
  if (typeof r["http_status"] === "number") {
    return json(r["http_status"], { error: r["error"] }, (r["headers"] as Record<string, string> | undefined) ?? {});
  }
  return round(r);
}

describe("cancelAll untilDone: shared conformance cases", () => {
  it.each(conformance.cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const last = c.responses[c.responses.length - 1]!;
    const { client, calls, sleeps } = clockedClient(
      c.responses.map((r) => reply(r)),
      c.responses_repeat_last ? () => reply(last) : undefined,
    );
    const run = client.trading.cancelAll({
      symbol: null,
      untilDone: true,
      ...(c.options?.max_rounds !== undefined ? { maxRounds: c.options.max_rounds } : {}),
      ...(c.options?.time_budget_s !== undefined ? { timeBudgetMs: c.options.time_budget_s * 1000 } : {}),
    });
    const e = c.expect;
    if (e.error_code) {
      const err = await run.then(
        () => null,
        (x: unknown) => x,
      );
      expect(err).toBeInstanceOf(CancelAllInterruptedError);
      const ie = err as CancelAllInterruptedError;
      expect((ie.error as { code?: string }).code).toBe(e.error_code);
      expect(new Set(ie.partial.cancelled)).toEqual(new Set(e.partial_cancelled ?? []));
      expect(calls.length).toBe(e.calls);
      expect(sleeps).toEqual(e.sleeps_s.map((s) => s * 1000));
      return;
    }
    const out = await run;
    expect(calls.length).toBe(e.calls);
    expect(out.rounds).toBe(e.calls);
    expect(sleeps).toEqual(e.sleeps_s.map((s) => s * 1000));
    expect(out.stopped).toBe(e.stopped);
    expect(new Set(out.cancelled)).toEqual(new Set(e.cancelled));
    expect(new Set(out.already_closed)).toEqual(new Set(e.already_closed));
    expect(new Set(out.failed)).toEqual(new Set(e.failed));
    expect(Object.fromEntries(out.failures.map((f) => [f.order_id, f.code]))).toEqual(e.failure_codes);
    expect(out.last_error_code).toBe(e.last_error_code);
    for (const call of calls) {
      expect(call.method).toBe("POST");
      expect(call.body).toEqual({});
      expect(call.headers.has("Idempotency-Key")).toBe(false);
    }
  });
});

describe("cancelAll", () => {
  it("makes one call by default and returns the typed response", async () => {
    const { client, calls } = clockedClient([
      round({ cancelled: ["o1"], already_closed: ["o2"], failed: [], has_more: true }),
    ]);
    const out = await client.trading.cancelAll({ symbol: "BTC/USDT" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toEqual({ symbol: "BTC/USDT" });
    expect(out).toEqual({ cancelled: ["o1"], already_closed: ["o2"], failed: [], failures: [], has_more: true });
    expect("rounds" in out).toBe(false);
  });

  it("an unknown symbol throws NotFoundError", async () => {
    const { client } = clockedClient([
      json(404, { error: { code: "NOT_FOUND", message: "no such market", retryable: false } }),
    ]);
    await expect(client.trading.cancelAll({ symbol: "NOPE/USDT" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("never sends more than maxRounds (default 20) requests, even when every round makes progress", async () => {
    let n = 0;
    const { client, calls, sleeps } = clockedClient([], () =>
      round({ cancelled: [`o${n++}`], already_closed: [], failed: [], has_more: true }),
    );
    const out = await client.trading.cancelAll({ symbol: null, untilDone: true });
    expect(calls.length).toBe(20);
    expect(out).toMatchObject({ rounds: 20, stopped: "max_rounds", has_more: true });
    expect(out.cancelled).toHaveLength(20);
    expect(sleeps).toEqual([]);
  });

  it("a 429 inside the loop waits its Retry-After exactly, and that wait counts against the time budget", async () => {
    const { client, calls, sleeps, elapsed } = clockedClient([
      json(429, { error: { code: "RATE_LIMITED", message: "slow", retryable: true, details: { retry_after_seconds: 119 } } },
        { "Retry-After": "119" }),
      round(pending(["p1"])),
    ]);
    const out = await client.trading.cancelAll({ symbol: null, untilDone: true });
    // The 429 is a round of its own (the transport does not retry inside the loop).
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([119_000]);
    // 119 s spent; the 1 s backoff would reach the 120 s budget, so the loop stops.
    expect(out).toMatchObject({ rounds: 2, stopped: "time_budget", failed: ["p1"] });
    expect(out.last_error_code).toBeUndefined();
    expect(elapsed()).toBe(119_000);
  });

  it("a rate-limiter block counts against the time budget (Remaining 0, Reset 170 s)", async () => {
    // CexyQA probe: a successful round whose headers empty the rate-limit window for 170 s. The
    // limiter would hold the next round inside the request, invisibly to the loop; the loop must
    // count that wait and stop instead of sleeping past its 120 s budget.
    const { client, calls, sleeps, elapsed } = clockedClient(
      [ok({ cancelled: ["o1"], already_closed: [], failed: [], failures: [], has_more: true },
        { "X-RateLimit-Limit": "300", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "170" })],
      undefined,
      { requestsPerMinute: 300 },
    );
    const out = await client.trading.cancelAll({ symbol: null, untilDone: true });
    expect(calls.length).toBe(1);
    expect(sleeps).toEqual([]);
    expect(elapsed()).toBe(0);
    expect(out).toMatchObject({ rounds: 1, stopped: "time_budget", last_error_code: "RATE_LIMITED", cancelled: ["o1"] });
  });

  it("a short rate-limiter block within the budget is waited, then the loop continues", async () => {
    const { client, calls, sleeps } = clockedClient(
      [
        ok({ cancelled: ["o1"], already_closed: [], failed: [], failures: [], has_more: true },
          { "X-RateLimit-Limit": "300", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "5" }),
        round({ cancelled: ["o2"], already_closed: [], failed: [], has_more: false }),
      ],
      undefined,
      { requestsPerMinute: 300 },
    );
    const out = await client.trading.cancelAll({ symbol: null, untilDone: true });
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([5_000]);
    expect(out).toMatchObject({ stopped: "done", cancelled: ["o1", "o2"] });
    expect(out.last_error_code).toBeUndefined();
  });

  it("20 rounds that all fail with a retryable 503 send exactly 20 requests", async () => {
    const { client, calls } = clockedClient([], () =>
      json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "busy", retryable: true } }),
    );
    const out = await client.trading.cancelAll({ symbol: null, untilDone: true, timeBudgetMs: 1e9 });
    expect(calls.length).toBe(20);
    expect(out).toMatchObject({ rounds: 20, stopped: "max_rounds", last_error_code: "SERVICE_UNAVAILABLE" });
  });

  it("a non-retryable error throws CancelAllInterruptedError with the error and the partial result", async () => {
    const { client } = clockedClient([
      round({ cancelled: ["o1"], already_closed: [], failed: [], has_more: true }),
      json(403, { error: { code: "FORBIDDEN", message: "missing trade scope", retryable: false } }),
    ]);
    const err = await client.trading.cancelAll({ symbol: null, untilDone: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelAllInterruptedError);
    expect((err as CancelAllInterruptedError).error).toBeInstanceOf(ForbiddenError);
    expect((err as CancelAllInterruptedError).partial).toMatchObject({ cancelled: ["o1"], rounds: 2 });
  });

  it("an order that ends cancelled or already closed is never also reported failed", async () => {
    const { client } = clockedClient([
      round(pending(["a", "b", "c"])),
      round({ ...pending(["c"]), cancelled: ["a"], already_closed: ["b"] }),
      round({ cancelled: [], already_closed: ["c"], failed: [], has_more: false }),
    ]);
    const out = await client.trading.cancelAll({ symbol: "BTC/USDT", untilDone: true });
    expect(out.stopped).toBe("done");
    expect(new Set(out.cancelled)).toEqual(new Set(["a"]));
    expect(new Set(out.already_closed)).toEqual(new Set(["b", "c"]));
    expect(out.failed).toEqual([]);
    expect(out.failures).toEqual([]);
  });

  it("rejects bad loop options", async () => {
    const { client } = clockedClient([]);
    await expect(client.trading.cancelAll({ symbol: null, untilDone: true, maxRounds: 0 })).rejects.toThrow(/maxRounds/);
    await expect(client.trading.cancelAll({ symbol: null, untilDone: true, timeBudgetMs: 0 })).rejects.toThrow(/timeBudgetMs/);
  });
});
