import { describe, expect, it } from "vitest";
import { CLIENT_ERROR_CODES, PagingCursorRepeatedError, PagingStalledError, isRetryable } from "../src/index.js";
import { json, loadJson, ok, testClient } from "./helpers.js";

interface PagingPage {
  request_cursor: string | null;
  http_status?: number;
  headers?: Record<string, string>;
  response: any;
}
interface PagingCase {
  id: string;
  pages: PagingPage[];
  expect: {
    ids?: string[];
    times?: number[];
    ids_before_error?: string[];
    requests: number;
    sleeps: number;
    min_sleep_seconds?: number;
    encoded_query_of_request_2?: string;
    error_code?: string;
    error_retryable?: boolean;
    has_account?: boolean;
  };
}

const paging = loadJson<{ operation: string; max_busy_retries: number; cases: PagingCase[]; funding_cases: PagingCase[] }>(
  "conformance/futures/history_paging.json",
);

async function runPaging(kind: "fills" | "funding", c: PagingCase) {
  // A case with an error answer needs the normal request-retry policy; the others run with request
  // retries off, so busy pages are ridden out by maxBusyRetries alone.
  const withHttpError = c.pages.some((p) => p.http_status !== undefined);
  const { client, calls, sleeps } = testClient({
    maxRetries: withHttpError ? 3 : 0,
    replies: c.pages.map((p) => (p.http_status !== undefined ? json(p.http_status, p.response, p.headers ?? {}) : ok(p.response))),
    fallback: () => new Error("more requests than the case has pages"),
  });
  const rows: any[] = [];
  let error: unknown;
  let end: { has_account: boolean } | undefined;
  try {
    const it: AsyncGenerator<any, { has_account: boolean }> = kind === "fills" ? client.futures.iterateFills() : client.futures.iterateFunding();
    for (;;) {
      const r = await it.next();
      if (r.done) {
        end = r.value;
        break;
      }
      rows.push(r.value);
    }
  } catch (e) {
    error = e;
  }

  // What the SDK sent: the cursor of each page, verbatim (absent on the first request).
  expect(calls.length).toBe(c.expect.requests);
  calls.forEach((call, i) => {
    expect(call.method).toBe("GET");
    expect(call.url.pathname).toBe(`/api/v1/futures/${kind}`);
    expect(call.url.searchParams.get("cursor"), `request ${i + 1}`).toBe(c.pages[i]!.request_cursor);
    expect(call.headers.get("X-API-Signature"), "signed").toMatch(/^[0-9a-f]{64}$/);
  });
  expect(calls[0]!.url.search).toBe("");
  expect(sleeps.length).toBe(c.expect.sleeps);
  if (c.expect.min_sleep_seconds !== undefined) for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(c.expect.min_sleep_seconds * 1000);
  if (c.expect.encoded_query_of_request_2 !== undefined) {
    expect(calls[1]!.url.search).toBe(`?${c.expect.encoded_query_of_request_2}`);
  }

  if (c.expect.error_code) {
    expect(rows.map((r) => r.id)).toEqual(c.expect.ids_before_error);
    const cls = c.expect.error_code === "PAGING_STALLED" ? PagingStalledError : PagingCursorRepeatedError;
    expect(error).toBeInstanceOf(cls);
    const e = error as PagingStalledError | PagingCursorRepeatedError;
    expect(e.code).toBe(c.expect.error_code);
    expect(e.retryable).toBe(c.expect.error_retryable);
    expect(isRetryable(e)).toBe(c.expect.error_retryable);
    expect(e.cursor).toBe(c.pages[c.pages.length - 1]!.request_cursor);
    if (e instanceof PagingStalledError) expect(e.attempts).toBe(paging.max_busy_retries + 1);
  } else {
    expect(error).toBeUndefined();
    if (c.expect.ids) expect(rows.map((r) => r.id)).toEqual(c.expect.ids);
    if (c.expect.times) expect(rows.map((r) => r.time)).toEqual(c.expect.times);
    expect(end).toEqual({ has_account: c.expect.has_account ?? true });
  }
}

describe("conformance/futures/history_paging.json", () => {
  it("covers GET /api/v1/futures/fills (and funding_cases) with the default of 3 busy retries", () => {
    expect(paging.operation).toBe("GET /api/v1/futures/fills");
    expect(paging.max_busy_retries).toBe(3);
    expect(paging.cases.map((c) => c.id)).toEqual([
      "short_pages_until_null",
      "cursor_sent_back_verbatim",
      "real_cursor_formats",
      "unavailable_mid_paging_retried",
      "busy_provider_same_cursor_retried",
      "busy_provider_gives_up_after_max_retries",
      "nonempty_page_repeating_cursor_fails",
      "no_futures_account",
    ]);
    expect(paging.funding_cases.map((c) => c.id)).toEqual(["funding_short_pages_until_null", "funding_busy_then_rows", "funding_no_account"]);
  });

  it.each(paging.cases.map((c) => [c.id, c] as const))("fills: %s", (_id, c) => runPaging("fills", c));
  it.each(paging.funding_cases.map((c) => [c.id, c] as const))("funding: %s", (_id, c) => runPaging("funding", c));
});

describe("futures history iterators", () => {
  const fill = (id: string) => ({ id, order_id: "o", coin: "BTC", side: "buy", price: "1", size: "1", direction: "Open Long", closed_pnl: "0", taker: true, time: 1 });

  it("busy waits use the client's backoff, and maxBusyRetries is configurable", async () => {
    const busy = ok({ has_account: true, fills: [], next_cursor: "c:S" });
    const { client, calls, sleeps } = testClient({ replies: [ok({ has_account: true, fills: [fill("f1")], next_cursor: "c:S" })], fallback: busy });
    const ids: string[] = [];
    await expect(
      (async () => {
        for await (const f of client.futures.iterateFills(undefined, { maxBusyRetries: 1 })) ids.push(f.id);
      })(),
    ).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.PAGING_STALLED, retryable: true, cursor: "c:S" });
    expect(ids).toEqual(["f1"]);
    expect(calls.length).toBe(3);
    expect(sleeps).toEqual([250]); // full jitter (random 0.5) of the 500 ms first backoff step
  });

  it("the busy count resets after progress", async () => {
    const empty = (next: string | null) => ok({ has_account: true, fills: [], next_cursor: next });
    const { client, calls, sleeps } = testClient({
      replies: [
        ok({ has_account: true, fills: [fill("f1")], next_cursor: "a" }),
        empty("a"),
        empty("a"),
        empty("a"),
        ok({ has_account: true, fills: [fill("f2")], next_cursor: "b" }),
        empty("b"),
        empty("b"),
        empty("b"),
        ok({ has_account: true, fills: [fill("f3")], next_cursor: null }),
      ],
    });
    const ids: string[] = [];
    for await (const f of client.futures.iterateFills()) ids.push(f.id);
    expect(ids).toEqual(["f1", "f2", "f3"]);
    expect(calls.length).toBe(9);
    expect(sleeps.length).toBe(6);
  });

  it("starts from a given cursor (or a unix-ms time) and honours maxItems", async () => {
    const { client, calls } = testClient({
      replies: [ok({ has_account: true, fills: [fill("f1"), fill("f2")], next_cursor: "n" })],
    });
    const ids: string[] = [];
    for await (const f of client.futures.iterateFills({ cursor: "1790000000000" }, { maxItems: 1 })) ids.push(f.id);
    expect(ids).toEqual(["f1"]);
    expect(calls.map((c) => c.url.search)).toEqual(["?cursor=1790000000000"]);
  });

  it("iterateFunding follows the same rules on /api/v1/futures/funding", async () => {
    const pay = (t: number) => ({ coin: "BTC", amount: "-0.1", position_size: "1", rate: "0.0001", time: t });
    const { client, calls, sleeps } = testClient({
      replies: [
        ok({ has_account: true, funding: [pay(3)], next_cursor: "x y" }),
        ok({ has_account: true, funding: [], next_cursor: "x y" }),
        ok({ has_account: true, funding: [], next_cursor: "z" }),
        ok({ has_account: true, funding: [pay(1)], next_cursor: null }),
      ],
    });
    const times: number[] = [];
    for await (const p of client.futures.iterateFunding()) times.push(p.time);
    expect(times).toEqual([3, 1]);
    expect(calls.map((c) => `${c.url.pathname}${c.url.search}`)).toEqual([
      "/api/v1/futures/funding",
      "/api/v1/futures/funding?cursor=x%20y",
      "/api/v1/futures/funding?cursor=x%20y",
      "/api/v1/futures/funding?cursor=z",
    ]);
    expect(sleeps.length).toBe(1);
  });

  it("has_account false ends iterateFunding with no rows", async () => {
    const { client, calls } = testClient({ replies: [ok({ has_account: false, funding: [], next_cursor: null })] });
    const it = client.futures.iterateFunding();
    expect(await it.next()).toEqual({ done: true, value: { has_account: false } });
    expect(calls.length).toBe(1);
  });
});

describe("futures data requests", () => {
  it("sends query parameters and unwraps data", async () => {
    const book = { coin: "BTC", bids: [{ price: "1", size: "2" }], asks: [], as_of: "2026-10-02T00:00:00Z", stale: false };
    const { client, calls } = testClient({ replies: [ok(book)], fallback: ok({}) });
    expect(await client.futures.orderBook("BTC", { depth: 5 })).toEqual(book);
    await client.futures.candles("kPEPE", { interval: "1h", before: 1790000000000 });
    await client.futures.trades("BTC", { limit: 100 });
    await client.futures.candles("BTC", { interval: "1m" });
    expect(calls.map((c) => `${c.url.pathname}${c.url.search}`)).toEqual([
      "/api/v1/futures/markets/BTC/orderbook?depth=5",
      "/api/v1/futures/markets/kPEPE/candles?interval=1h&before=1790000000000",
      "/api/v1/futures/markets/BTC/trades?limit=100",
      "/api/v1/futures/markets/BTC/candles?interval=1m",
    ]);
  });

  it("public market data is sent without credentials; account data is signed", async () => {
    const { client, calls } = testClient({ fallback: ok({ has_account: false, stale: false }) });
    await client.futures.markets();
    await client.futures.positions();
    expect(calls[0]!.headers.has("X-API-Key")).toBe(false);
    expect(calls[1]!.headers.get("X-API-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("503 futures_data_unavailable is retried after Retry-After", async () => {
    const unavailable = json(
      503,
      { error: { code: "SERVICE_UNAVAILABLE", message: "futures data unavailable", retryable: true, details: { reason: "futures_data_unavailable" } } },
      { "Retry-After": "2" },
    );
    const markets = { markets: [], as_of: "2026-10-02T00:00:00Z", stale: true };
    const { client, calls, sleeps } = testClient({ replies: [unavailable, ok(markets)] });
    expect(await client.futures.markets()).toEqual(markets);
    expect(calls.length).toBe(2);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(2000);
  });
});
