import { describe, expect, it } from "vitest";
import { InvalidAmountError, isAmount, type PlaceOrderRequest } from "../src/index.js";
import { ok, testClient } from "./helpers.js";

describe("amounts are decimal strings", () => {
  it.each(["price", "quantity", "quote_quantity", "stop_price"])("placeOrder rejects a number %s before sending", async (field) => {
    const { client, calls } = testClient();
    const order = { symbol: "BTC/USDT", side: "buy", type: "limit", price: "1", quantity: "1", [field]: 0.1 } as unknown as PlaceOrderRequest;
    const err = await client.trading.placeOrder(order).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidAmountError);
    expect((err as InvalidAmountError).field).toBe(field);
    expect(calls.length).toBe(0);
  });

  it("rejects bigint and malformed strings (exponent, commas, blanks)", async () => {
    const { client, calls } = testClient();
    for (const bad of [10n, "1e-8", "1,5", "", " 1", "NaN", "0x10"]) {
      const order = { symbol: "BTC/USDT", side: "buy", type: "market", quantity: bad } as unknown as PlaceOrderRequest;
      await expect(client.trading.placeOrder(order)).rejects.toBeInstanceOf(InvalidAmountError);
    }
    expect(calls.length).toBe(0);
  });

  it("pool join/exit reject numbers", async () => {
    const { client, calls } = testClient();
    await expect(client.pools.join("BTC/USDT", { base_amount: 1 as unknown as string, quote_amount: "2" })).rejects.toBeInstanceOf(
      InvalidAmountError,
    );
    await expect(client.pools.exit("BTC/USDT", { shares: 0.5 as unknown as string })).rejects.toBeInstanceOf(InvalidAmountError);
    expect(calls.length).toBe(0);
  });

  it("sends valid strings unchanged and omits nothing", async () => {
    const { client, calls } = testClient({ fallback: ok({ order: {}, fills: [] }) });
    await client.trading.placeOrder({ symbol: "BTC/USDT", side: "sell", type: "limit", price: "60000.10", quantity: "0.00100000" });
    expect(calls[0]!.body.price).toBe("60000.10");
    expect(calls[0]!.body.quantity).toBe("0.00100000");
  });

  it("isAmount", () => {
    expect(isAmount("1.50000000")).toBe(true);
    expect(isAmount("-2")).toBe(true);
    expect(isAmount(1.5)).toBe(false);
    expect(isAmount(".5")).toBe(false);
  });
});
