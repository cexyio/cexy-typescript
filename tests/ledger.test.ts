import { describe, expect, it } from "vitest";
import { isKnownErrorCode, isLedgerReference, type LedgerEntry } from "../src/index.js";
import { json, testClient } from "./helpers.js";

const entry = (reference: Record<string, unknown>) => ({
  id: "e1", asset: "USDT", amount: "1", balance_after: "1", kind: "trade", created_at: "2026-09-28T00:00:00Z",
  sequence: 1, reference,
});

describe("ledger references (H-1)", () => {
  it("decodes known and unknown reference types without throwing", async () => {
    const { client } = testClient({ replies: [json(200, { items: [
      entry({ type: "trade", order_id: "a".repeat(24), trade_id: "b".repeat(24) }),
      entry({ type: "system", cause: "fee_rebate" }),
      entry({ type: "brand_new_cause", whatever: 42 }),
    ], has_more: false })] });
    const page = await client.account.ledger({ limit: 3 });
    const refs = page.items.map((e: LedgerEntry) => e.reference);
    expect(isLedgerReference(refs[0]!, "trade")).toBe(true);
    const r0 = refs[0]!;
    if (isLedgerReference(r0, "trade")) expect(r0.trade_id).toBe("b".repeat(24));
    expect(isLedgerReference(refs[1]!, "system")).toBe(true);
    expect(isLedgerReference(refs[1]!, "trade")).toBe(false);
    expect(isLedgerReference(refs[2]!)).toBe(false);
    expect(refs[2]).toEqual({ type: "brand_new_cause", whatever: 42 });
  });

  it("ids are not format-checked", async () => {
    const { client } = testClient({ replies: [json(200, { items: [entry({ type: "order", order_id: "not-24-hex" })], has_more: false })] });
    const page = await client.account.ledger();
    const ref = page.items[0]!.reference;
    expect(isLedgerReference(ref, "order") && ref.order_id).toBe("not-24-hex");
  });

  it("PRICE_UNAVAILABLE is a known server code", () => {
    expect(isKnownErrorCode("PRICE_UNAVAILABLE")).toBe(true);
  });
});
