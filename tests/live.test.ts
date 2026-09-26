/**
 * Opt-in live smoke test against the public, unauthenticated API (set the env var CEXY_LIVE_TESTS to 1).
 * Three GET requests, no credentials, SDK User-Agent. Skipped by default and in CI.
 */
import { describe, expect, it } from "vitest";
import { CexyClient, isAmount } from "../src/index.js";

const live = process.env.CEXY_LIVE_TESTS === "1";
const requests: string[] = [];

describe.skipIf(!live)("live public API (read-only)", () => {
  const client = new CexyClient({
    maxRetries: 1,
    fetch: (url, init) => {
      const h = new Headers(init.headers);
      if (h.has("X-API-Key") || h.has("X-API-Secret") || h.has("Authorization")) throw new Error("credentials must never be sent here");
      requests.push(`${init.method} ${new URL(url).pathname}`);
      return fetch(url, init);
    },
  });
  let symbol = "BTC/USDT";

  it("time", async () => {
    const t = await client.time();
    expect(typeof t.epoch_ms).toBe("number");
    expect(typeof t.iso).toBe("string");
    expect(Math.abs(t.epoch_ms - Date.now())).toBeLessThan(5 * 60_000);
  });

  it("markets.list", async () => {
    const markets = await client.markets.list();
    expect(Array.isArray(markets)).toBe(true);
    expect(markets.length).toBeGreaterThan(0);
    const m = markets.find((x) => x.status === "active") ?? markets[0]!;
    symbol = m.symbol;
    for (const f of ["last_price", "min_quantity", "tick_size", "lot_size"] as const) expect(isAmount(m[f]), `${f}=${m[f]}`).toBe(true);
  });

  it("one order book", async () => {
    const book = await client.markets.orderbook(symbol, { depth: 5 });
    expect(book.symbol).toBe(symbol);
    expect(typeof book.sequence).toBe("number");
    for (const [p, q] of [...book.bids, ...book.asks]) {
      expect(isAmount(p)).toBe(true);
      expect(isAmount(q)).toBe(true);
    }
    expect(requests.length).toBeLessThanOrEqual(6);
  });
});
