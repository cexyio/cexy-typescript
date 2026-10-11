/**
 * placeOrders / cancelOrders / cancelOrderByClientId: the shared conformance cases in
 * conformance/trading/batch_orders.json (every case), plus the limiter and hold behaviour.
 */
import { describe, expect, it } from "vitest";
import {
  CLIENT_ORDER_ID_PATTERN,
  CexyApiError,
  CexyClient,
  CexyConfigError,
  CexyConnectionError,
  InvalidAmountError,
  type BatchCancelResult,
  type BatchOrderInput,
  type BatchPlaceResult,
  type CancelOrderEntry,
  type CexyClientOptions,
} from "../src/index.js";
import { json, loadJson, TEST_KEY, TEST_SECRET } from "./helpers.js";

type Item = Record<string, any>;
interface Case {
  id: string;
  request?: Item;
  client_order_id?: string;
  attempts: Item[];
  lookups?: Record<string, Item>;
  expect: Item;
}
const FIX = loadJson<{
  order_template: Item;
  place: Case[];
  cancel: Case[];
  cancel_by_client_id: Case[];
  validation: { id: string; call: "place" | "cancel"; request: Item }[];
  valid: { id: string; call: "place" | "cancel"; client_order_id?: string; orders_count?: number }[];
  cid_path: { client_order_id: string; path: string }[];
  cost: { calls: Record<string, { request_tokens: string; order_actions: string }> };
}>("conformance/trading/batch_orders.json");

const PLACE_PATH = "/api/v1/trading/orders/batch";
const CANCEL_PATH = "/api/v1/trading/orders/cancel-batch";
const BY_CID = "/api/v1/trading/orders/by-client-id/";
const BY_ID = "/api/v1/trading/orders/";

const order = (stub: Item) => ({ ...FIX.order_template, ...stub });
function withOrders(data: Item): Item {
  const out = JSON.parse(JSON.stringify(data)) as Item;
  for (const r of out["results"] ?? []) if (r.order) r.order = order(r.order);
  return out;
}
function reply(item: Item, data: (d: Item) => Item = withOrders): Response {
  if ("network_error" in item) throw new TypeError("fetch failed", { cause: new Error("lost response") });
  if (item["http_status"] === 200) return json(200, { data: data(item["data"]) });
  return json(item["http_status"], { error: item["error"] }, item["headers"] ?? {});
}

interface Sent {
  method: string;
  path: string;
  raw: string | undefined;
  nonce: string | null;
}

const EMPTY_BATCH = { placed: 0, failed: 0, cancelled: 0, results: [] };
const isBatchPath = (s: Sent) => s.method === "POST" && (s.path === PLACE_PATH || s.path === CANCEL_PATH);
/** The default answer: an empty batch result for a batch call, else an order. */
const defaultAnswer = (s: Sent) => json(200, { data: isBatchPath(s) ? EMPTY_BATCH : order({ id: "o_other" }) });

/**
 * A fake server on a fake clock. The call under test (`target`) is answered from `attempts`
 * while they last; GETs are answered from `lookups`; anything else from `other`.
 */
function server(
  c: Partial<Case>,
  opts: Partial<CexyClientOptions> = {},
  other: (s: Sent) => Response = defaultAnswer,
  target: (s: Sent) => boolean = () => false,
) {
  const sent: Sent[] = [];
  const bodies: string[] = [];
  const nonces: (string | null)[] = [];
  const lookups: string[] = [];
  const sleeps: number[] = [];
  const clock = { t: 1_000_000 };
  /** The fake clock's time when the first 429 attempt was answered. */
  const held = { at: null as number | null };
  let n = 0;
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const s: Sent = {
      method: init.method ?? "GET",
      path: url.pathname,
      raw: typeof init.body === "string" ? init.body : undefined,
      nonce: new Headers(init.headers).get("X-API-Nonce"),
    };
    sent.push(s);
    if (target(s) && c.attempts && n < c.attempts.length) {
      bodies.push(s.raw ?? "");
      nonces.push(s.nonce);
      const item = c.attempts[n++]!;
      if (item["http_status"] === 429 && held.at === null) held.at = clock.t;
      if (item["echo_cids"]) {
        const cids = (JSON.parse(s.raw!) as { orders: Item[] }).orders.map((o) => o["client_order_id"] as string);
        return reply(item, (d) => {
          const out = withOrders(d);
          for (const r of out["results"]) if (r.client_order_id === "<generated>") r.client_order_id = cids[r.index];
          return out;
        });
      }
      return reply(item);
    }
    if (s.method === "GET" && c.lookups) {
      const key = s.path.startsWith(BY_CID)
        ? `cid:${decodeURIComponent(s.path.slice(BY_CID.length))}`
        : `order:${decodeURIComponent(s.path.slice(BY_ID.length))}`;
      lookups.push(key);
      const item = c.lookups[key];
      if (!item) throw new Error(`unexpected lookup ${key}`);
      return reply(item, order);
    }
    if (target(s)) {
      // More attempts than the case gives: counted, then answered by `other`.
      bodies.push(s.raw ?? "");
      nonces.push(s.nonce);
    }
    return other(s);
  };
  const client = new CexyClient({
    apiKey: TEST_KEY,
    apiSecret: TEST_SECRET,
    fetch,
    random: () => 0.5,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    maxRetries: 3,
    ...opts,
  });
  return { client, sent, bodies, nonces, lookups, sleeps, clock, held };
}

async function settle(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (v) => v,
    (e: unknown) => e,
  );
}

function checkCommon(c: Case, srv: ReturnType<typeof server>, res: unknown): void {
  const e = c.expect;
  expect(srv.bodies.length).toBe(e["calls"]);
  if (e["same_body"]) {
    expect(new Set(srv.bodies).size).toBe(1);
    expect(new Set(srv.nonces).size).toBe(srv.nonces.length); // every attempt signed afresh
    expect(srv.nonces.every((x) => typeof x === "string" && x.length > 0)).toBe(true);
  }
  if ("lookups" in e) expect(srv.lookups).toEqual(e["lookups"]);
  if (e["error"] === "connection") {
    expect(res).toBeInstanceOf(CexyConnectionError);
  } else if ("error_code" in e && !("results" in e)) {
    expect(res).toBeInstanceOf(CexyApiError);
    expect((res as CexyApiError).code).toBe(e["error_code"]);
    if ("error_details_limit" in e) expect((res as CexyApiError).details["limit"]).toBe(e["error_details_limit"]);
  }
}

function checkResults(e: Item, res: BatchPlaceResult | BatchCancelResult, kind: "place" | "cancel"): void {
  const got = res.results.map((o) => {
    const row: Item = { index: o.index, outcome: o.outcome };
    if (o.outcome === "placed" || o.outcome === "recovered" || o.outcome === "cancelled") {
      row["order_id"] = o.order_id;
      row["status"] = o.status;
    }
    if (o.outcome === "failed") row["error_code"] = o.error?.code;
    return row;
  });
  expect(got).toEqual(e["results"]);
  const first = kind === "place" ? (res as BatchPlaceResult).placed : (res as BatchCancelResult).cancelled;
  expect([first, res.failed, res.unknown]).toEqual([e[kind === "place" ? "placed" : "cancelled"], e["failed"], e["unknown"]]);
}

/**
 * `expect.hold: "placements"`: rewind the fake clock to the 429 and check that a placement is
 * held while a read and a cancel go at once, and that the client limiter holds nothing.
 */
async function checkHold(srv: ReturnType<typeof server>, heldAt: number): Promise<void> {
  expect(srv.client.rateLimit?.blockedUntil).toBe(0);
  srv.clock.t = heldAt;
  srv.sleeps.length = 0;
  await srv.client.trading.order("o_read");
  await srv.client.trading.cancelOrder("o_cancel");
  await srv.client.trading.cancelOrders([{ order_id: "o_cancel" }]);
  expect(srv.sleeps).toEqual([]);
  await srv.client.trading.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", quantity: "1" });
  expect(srv.sleeps.length).toBe(1);
  expect(srv.sleeps[0]).toBeGreaterThanOrEqual(1000);
}

const RATE = { rateLimit: { requestsPerMinute: 6000 } } as const;

describe("conformance: place", () => {
  it.each(FIX.place.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const srv = server(c, RATE, defaultAnswer, (s) => s.method === "POST" && s.path === PLACE_PATH);
    const req = c.request!;
    const res = await settle(srv.client.trading.placeOrders(req["symbol"], req["orders"]));
    checkCommon(c, srv, res);
    const e = c.expect;
    if ("results" in e) checkResults(e, res as BatchPlaceResult, "place");
    for (const i of (e["generated_cid_indexes"] ?? []) as number[]) {
      const sentCid = (JSON.parse(srv.bodies[0]!) as { orders: Item[] }).orders[i]!["client_order_id"] as string;
      expect(sentCid).toMatch(CLIENT_ORDER_ID_PATTERN);
      expect((res as BatchPlaceResult).results[i]!.client_order_id).toBe(sentCid);
    }
    if (e["hold"] === "placements") await checkHold(srv, srv.held.at!);
  });
});

describe("conformance: cancel", () => {
  it.each(FIX.cancel.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const srv = server(c, RATE, defaultAnswer, (s) => s.method === "POST" && s.path === CANCEL_PATH);
    const res = await settle(srv.client.trading.cancelOrders(c.request!["orders"]));
    checkCommon(c, srv, res);
    if ("results" in c.expect) checkResults(c.expect, res as BatchCancelResult, "cancel");
    if (c.expect["hold"] === "placements") await checkHold(srv, srv.held.at!);
  });
});

describe("conformance: cancel_by_client_id", () => {
  it.each(FIX.cancel_by_client_id.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const srv = server(c, {}, defaultAnswer, (s) => s.method === "DELETE" && s.path.startsWith(BY_CID));
    const res = await settle(srv.client.trading.cancelOrderByClientId(c.client_order_id!));
    checkCommon(c, srv, res);
    const e = c.expect;
    if ("order_id" in e) {
      expect((res as { id: string }).id).toBe(e["order_id"]);
      expect((res as { status: string }).status).toBe(e["status"]);
    }
  });
});

function expand(req: Item, call: "place" | "cancel"): Item[] {
  if (Array.isArray(req["orders"])) return req["orders"];
  const n = req["orders_count"] as number;
  return Array.from({ length: n }, (_, i) =>
    call === "place" ? { side: "buy", type: "limit", price: "100", quantity: "1", client_order_id: `c${i}` } : { order_id: `o${i}` },
  );
}

describe("conformance: validation (refused locally)", () => {
  it.each(FIX.validation.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const srv = server({});
    const run =
      c.call === "place"
        ? srv.client.trading.placeOrders(c.request["symbol"], expand(c.request, "place") as BatchOrderInput[])
        : srv.client.trading.cancelOrders(expand(c.request, "cancel") as CancelOrderEntry[]);
    await expect(run).rejects.toBeInstanceOf(CexyConfigError);
    expect(srv.sent).toEqual([]);
  });
});

describe("conformance: valid (sent)", () => {
  it.each(FIX.valid.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const srv = server({});
    if (c.call === "place") {
      const orders = c.client_order_id
        ? [{ side: "buy", type: "limit", price: "1", quantity: "1", client_order_id: c.client_order_id }]
        : expand({ orders_count: c.orders_count }, "place");
      await srv.client.trading.placeOrders("BTC/USDT", orders as BatchOrderInput[]);
      expect(JSON.parse(srv.sent[0]!.raw!).orders.length).toBe(orders.length);
    } else {
      await srv.client.trading.cancelOrders(expand({ orders_count: c.orders_count }, "cancel") as CancelOrderEntry[]);
    }
    expect(srv.sent.length).toBe(1);
  });
});

describe("conformance: cid_path", () => {
  it.each(FIX.cid_path.map((c) => [c.client_order_id, c] as const))("%s", async (_id, c) => {
    const srv = server({});
    await srv.client.trading.cancelOrderByClientId(c.client_order_id);
    expect(srv.sent[0]!.method).toBe("DELETE");
    expect(srv.sent[0]!.path).toBe(c.path);
  });
});

describe("conformance: cost", () => {
  const N = 3;
  const calls: Record<string, (c: CexyClient) => Promise<unknown>> = {
    place_order: (c) => c.trading.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", quantity: "1" }),
    place_orders: (c) =>
      c.trading.placeOrders(
        "BTC/USDT",
        Array.from({ length: N }, () => ({ side: "buy" as const, type: "market" as const, quantity: "1" })),
      ),
    cancel_order: (c) => c.trading.cancelOrder("o1"),
    cancel_order_by_client_id: (c) => c.trading.cancelOrderByClientId("c1"),
    cancel_orders: (c) => c.trading.cancelOrders(Array.from({ length: N }, (_, i) => ({ order_id: `o${i}` }))),
    cancel_all: (c) => c.trading.cancelAll({ symbol: "BTC/USDT" }),
  };
  const expected = (v: string) => (v === "N" ? N : Number(v));
  const answer = (s: Sent) =>
    s.path === "/api/v1/trading/orders/cancel-all"
      ? json(200, { data: { cancelled: [], already_closed: [], failed: [], failures: [], has_more: false } })
      : s.path === PLACE_PATH || s.path === CANCEL_PATH
        ? json(200, { data: EMPTY_BATCH })
        : json(200, { data: order({ id: "o1" }) });

  it("covers every call in the cost table", () => {
    expect(Object.keys(calls).sort()).toEqual(Object.keys(FIX.cost.calls).sort());
  });

  it.each(Object.entries(FIX.cost.calls))("%s", async (name, cost) => {
    // Request tokens: the client limiter's tokens before and after (the clock stands still).
    const a = server({}, RATE, answer);
    const before = a.client.rateLimit!.tokens;
    await calls[name]!(a.client);
    expect(before - a.client.rateLimit!.tokens).toBe(expected(cost.request_tokens));
    // Order actions: a budget of 1 a second (bucket 1). After k actions, one more placement
    // waits k seconds; with none spent it goes at once.
    const b = server({}, { rateLimit: false, orderActionsPerSecond: 1 }, answer);
    await calls[name]!(b.client);
    b.sleeps.length = 0;
    await calls["place_order"]!(b.client);
    const k = expected(cost.order_actions);
    expect(b.sleeps).toEqual(k === 0 ? [] : [k * 1000]);
  });
});

describe("placements hold and order budget", () => {
  const orderActions429 = json(429, {
    error: { code: "RATE_LIMITED", message: "slow down", retryable: true, details: { retry_after_seconds: 2, limit: "order_actions" } },
  });
  const request429 = json(429, {
    error: { code: "RATE_LIMITED", message: "slow down", retryable: true, details: { retry_after_seconds: 2 } },
  });

  it("an order_actions 429 delays placements (single and batch), not reads or cancels", async () => {
    let first = true;
    const srv = server({}, RATE, (s) => {
      if (first && s.method === "POST") {
        first = false;
        return orderActions429.clone();
      }
      return defaultAnswer(s);
    });
    await expect(
      srv.client.trading.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", quantity: "1" }, { maxRetries: 0 }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await srv.client.trading.order("o1");
    await srv.client.trading.openOrders();
    await srv.client.trading.cancelOrder("o1");
    await srv.client.trading.cancelOrderByClientId("c1");
    await srv.client.trading.cancelOrders([{ order_id: "o1" }]);
    expect(srv.sleeps).toEqual([]);
    await srv.client.trading.placeOrders("BTC/USDT", [{ side: "buy", type: "market", quantity: "1" }]);
    expect(srv.sleeps).toEqual([2000 + 125]); // the hold plus jitter (random 0.5 of 250 ms)
    srv.sleeps.length = 0;
    await srv.client.trading.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", quantity: "1" });
    expect(srv.sleeps).toEqual([]); // the hold has passed
  });

  it("a request-limit 429 still holds every call", async () => {
    let first = true;
    const srv = server({}, RATE, () => {
      if (first) {
        first = false;
        return request429.clone();
      }
      return json(200, { data: order({ id: "o1" }) });
    });
    await expect(srv.client.trading.order("o1", { maxRetries: 0 })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await srv.client.trading.order("o1");
    expect(srv.sleeps).toEqual([2000]);
    srv.clock.t -= 2000;
    srv.sleeps.length = 0;
    await srv.client.trading.cancelOrder("o1");
    expect(srv.sleeps).toEqual([2000]);
  });

  it("the order budget counts placements only; cancels never wait for it", async () => {
    const srv = server({}, { rateLimit: false, orderActionsPerSecond: 2 });
    const two = [
      { side: "buy" as const, type: "market" as const, quantity: "1" },
      { side: "buy" as const, type: "market" as const, quantity: "1" },
    ];
    await srv.client.trading.placeOrders("BTC/USDT", two);
    await srv.client.trading.cancelOrders(Array.from({ length: 50 }, (_, i) => ({ order_id: `o${i}` })));
    await srv.client.trading.cancelOrder("o1");
    expect(srv.sleeps).toEqual([]);
    await srv.client.trading.placeOrders("BTC/USDT", two);
    expect(srv.sleeps).toEqual([1000]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "50"])("orderActionsPerSecond %s is refused", (bad) => {
    expect(() => new CexyClient({ orderActionsPerSecond: bad as number })).toThrow(CexyConfigError);
  });
});

describe("placeOrders", () => {
  it("sends the wire body once built: generated ids for missing ones, given ids kept, request order kept", async () => {
    const srv = server({});
    await srv.client.trading.placeOrders("BTC/USDT", [
      { side: "buy", type: "limit", price: "100", quantity: "1", time_in_force: "ioc" },
      { side: "sell", type: "market", quote_quantity: "50", client_order_id: "mine:1", price: null },
    ]);
    const body = JSON.parse(srv.sent[0]!.raw!);
    expect(body.symbol).toBe("BTC/USDT");
    expect(body.orders[0]).toEqual({
      side: "buy",
      type: "limit",
      price: "100",
      quantity: "1",
      time_in_force: "ioc",
      client_order_id: expect.stringMatching(CLIENT_ORDER_ID_PATTERN),
    });
    expect(body.orders[1]).toEqual({ side: "sell", type: "market", quote_quantity: "50", client_order_id: "mine:1" });
  });

  it("refuses number amounts and a missing side before sending", async () => {
    const srv = server({});
    await expect(
      srv.client.trading.placeOrders("BTC/USDT", [{ side: "buy", type: "limit", price: 1 as unknown as string, quantity: "1" }]),
    ).rejects.toBeInstanceOf(InvalidAmountError);
    await expect(srv.client.trading.placeOrders("BTC/USDT", [{ type: "market", quantity: "1" } as BatchOrderInput])).rejects.toBeInstanceOf(
      CexyConfigError,
    );
    await expect(srv.client.trading.placeOrders("", [{ side: "buy", type: "market", quantity: "1" }])).rejects.toBeInstanceOf(CexyConfigError);
    expect(srv.sent).toEqual([]);
  });
});

describe("retries of a batch", () => {
  it("every attempt is signed afresh (new nonce) and sends the same body bytes", async () => {
    const c: Partial<Case> = {
      attempts: [{ network_error: "timeout" }, { http_status: 502, error: { code: "SERVICE_UNAVAILABLE", message: "x", retryable: true } }],
    };
    const srv = server(c, {}, defaultAnswer, (s) => s.method === "POST" && s.path === PLACE_PATH);
    await srv.client.trading.placeOrders("BTC/USDT", [{ side: "buy", type: "market", quantity: "1" }]);
    expect(srv.bodies.length).toBe(3);
    expect(new Set(srv.bodies).size).toBe(1);
    expect(srv.nonces.every((x) => typeof x === "string" && x.length > 0)).toBe(true);
    expect(new Set(srv.nonces).size).toBe(3);
  });
});

describe("recovery lookups after an abort", () => {
  it("an abort during a lookup keeps the batch result: that item and later ones are unknown, no further lookup", async () => {
    const exists = (cid: string) => ({
      index: 0,
      client_order_id: cid,
      order: null,
      fills: [],
      error: { code: "ALREADY_EXISTS", message: "exists", retryable: false, details: { client_order_id: cid } },
    });
    const ctrl = new AbortController();
    const c: Partial<Case> = {
      attempts: [
        { network_error: "timeout" },
        {
          http_status: 200,
          data: {
            placed: 1,
            failed: 2,
            results: [
              { ...exists("c1"), index: 0 },
              { index: 1, client_order_id: "c2", order: { id: "o2", status: "open" }, fills: [], error: null },
              { ...exists("c3"), index: 2 },
            ],
          },
        },
      ],
    };
    const lookups: string[] = [];
    const other = (s: Sent): Response => {
      lookups.push(s.path);
      ctrl.abort();
      throw new DOMException("aborted", "AbortError");
    };
    const srv = server(c, {}, other, (s) => s.method === "POST" && s.path === PLACE_PATH);
    const res = await srv.client.trading.placeOrders(
      "BTC/USDT",
      ["c1", "c2", "c3"].map((id) => ({ side: "buy" as const, type: "market" as const, quantity: "1", client_order_id: id })),
      { signal: ctrl.signal },
    );
    expect(lookups).toEqual([`${BY_CID}c1`]);
    expect(res.results.map((r) => r.outcome)).toEqual(["unknown", "placed", "unknown"]);
    expect([res.placed, res.failed, res.unknown]).toEqual([1, 0, 2]);
  });
});
