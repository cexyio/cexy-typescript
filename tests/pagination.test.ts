import { describe, expect, it } from "vitest";
import { ok, json, order, testClient } from "./helpers.js";

const page = (ids: string[], next?: string) => json(200, { items: ids.map((id) => order({ id })), has_more: !!next, ...(next ? { next_cursor: next } : {}) });

describe("cursor pagination", () => {
  it("iterateOrderHistory walks every page with for await, passing cursors back", async () => {
    const { client, calls } = testClient({ replies: [page(["a", "b"], "c1"), page(["c", "d"], "c2"), page(["e"])] });
    const ids: string[] = [];
    for await (const o of client.trading.iterateOrderHistory({ symbol: "BTC/USDT", limit: 2 })) ids.push(o.id);
    expect(ids).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls.length).toBe(3);
    expect(calls[0]!.url.searchParams.get("cursor")).toBeNull();
    expect(calls[1]!.url.searchParams.get("cursor")).toBe("c1");
    expect(calls[2]!.url.searchParams.get("cursor")).toBe("c2");
    expect(calls.every((c) => c.url.searchParams.get("symbol") === "BTC/USDT" && c.url.searchParams.get("limit") === "2")).toBe(true);
  });

  it("stops lazily: breaking out fetches no further pages", async () => {
    const { client, calls } = testClient({ replies: [page(["a", "b"], "c1"), page(["c"])] });
    for await (const o of client.trading.iterateOrderHistory()) {
      if (o.id === "a") break;
    }
    expect(calls.length).toBe(1);
  });

  it("maxItems caps the total", async () => {
    const { client, calls } = testClient({ replies: [page(["a", "b"], "c1"), page(["c", "d"], "c2")] });
    const ids: string[] = [];
    for await (const o of client.trading.iterateOrderHistory({}, { maxItems: 3 })) ids.push(o.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(calls.length).toBe(2);
  });

  it("stops on has_more=false even if a cursor is present, and on a repeated cursor", async () => {
    const { client, calls } = testClient({
      replies: [json(200, { items: [order()], has_more: false, next_cursor: "x" })],
    });
    let n = 0;
    for await (const _ of client.account.iterateLedger()) n++;
    expect(n).toBe(1);
    expect(calls.length).toBe(1);

    const t2 = testClient({ replies: [page(["a"], "same"), page(["b"], "same"), page(["c"], "same")] });
    const ids: string[] = [];
    for await (const o of t2.client.wallet.iterateDeposits()) ids.push((o as unknown as { id: string }).id);
    expect(ids).toEqual(["a", "b"]);
  });

  it("every paginated listing has an iterator", async () => {
    const { client } = testClient({ fallback: ok(null) });
    const iters = [
      client.markets.iterateTrades("BTC/USDT"),
      client.account.iterateLedger(),
      client.account.iterateNotifications(),
      client.wallet.iterateDeposits(),
      client.wallet.iterateWithdrawals(),
      client.trading.iterateOrderHistory(),
      client.trading.iterateTrades(),
    ];
    for (const it of iters) expect(typeof it[Symbol.asyncIterator]).toBe("function");
  });
});
