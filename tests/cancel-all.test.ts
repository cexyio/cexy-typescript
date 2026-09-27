import { describe, expect, it } from "vitest";
import { CexyClient, NotFoundError } from "../src/index.js";
import { json, loadJson, mockFetch, ok, TEST_KEY, TEST_SECRET, type Reply } from "./helpers.js";

interface Case {
  id: string;
  options?: { max_rounds?: number; time_budget_s?: number };
  responses_repeat_last?: boolean;
  responses: Record<string, unknown>[];
  expect: {
    calls: number;
    sleeps_s: number[];
    stopped: string;
    cancelled: string[];
    already_closed: string[];
    failed: string[];
    failure_codes: Record<string, string>;
  };
}

const conformance = loadJson<{ cases: Case[] }>("conformance/trading/cancel_all_until_done.json");

/** A client on a fake clock: calls take no time, and every sleep (loop or transport) advances it. */
function clockedClient(replies: Reply[], fallback?: Reply) {
  const m = mockFetch(replies, fallback);
  let t = 1_000_000;
  const sleeps: number[] = [];
  const client = new CexyClient({
    apiKey: TEST_KEY,
    apiSecret: TEST_SECRET,
    fetch: m.fetch,
    rateLimit: false,
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

describe("cancelAll untilDone: shared conformance cases", () => {
  it.each(conformance.cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const last = c.responses[c.responses.length - 1]!;
    const { client, calls, sleeps } = clockedClient(
      c.responses.map((r) => round(r)),
      c.responses_repeat_last ? () => round(last) : undefined,
    );
    const out = await client.trading.cancelAll({
      symbol: null,
      untilDone: true,
      ...(c.options?.max_rounds !== undefined ? { maxRounds: c.options.max_rounds } : {}),
      ...(c.options?.time_budget_s !== undefined ? { timeBudgetMs: c.options.time_budget_s * 1000 } : {}),
    });
    expect(calls.length).toBe(c.expect.calls);
    expect(out.rounds).toBe(c.expect.calls);
    expect(sleeps).toEqual(c.expect.sleeps_s.map((s) => s * 1000));
    expect(out.stopped).toBe(c.expect.stopped);
    expect(new Set(out.cancelled)).toEqual(new Set(c.expect.cancelled));
    expect(new Set(out.already_closed)).toEqual(new Set(c.expect.already_closed));
    expect(new Set(out.failed)).toEqual(new Set(c.expect.failed));
    expect(Object.fromEntries(out.failures.map((f) => [f.order_id, f.code]))).toEqual(c.expect.failure_codes);
    for (const call of calls) {
      expect(call.method).toBe("POST");
      expect(call.body).toEqual({});
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

  it("a 429 inside the loop waits its Retry-After, and that wait counts against the time budget", async () => {
    const { client, calls, sleeps, elapsed } = clockedClient([
      json(429, { error: { code: "RATE_LIMITED", message: "slow", retryable: true, details: { retry_after_seconds: 119 } } },
        { "Retry-After": "119" }),
      round(pending(["p1"])),
    ]);
    const out = await client.trading.cancelAll({ symbol: null, untilDone: true });
    expect(calls.length).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(119_000); // Retry-After, plus the transport's jitter
    // About 119 s spent; the 1 s backoff would reach the 120 s budget, so the loop stops.
    expect(out).toMatchObject({ rounds: 1, stopped: "time_budget", failed: ["p1"] });
    expect(elapsed()).toBe(sleeps[0]);
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
