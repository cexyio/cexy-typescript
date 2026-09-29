import { describe, expect, it } from "vitest";
import type { Balance, HeldIncoming } from "../src/index.js";
import { ok, testClient } from "./helpers.js";

const base = { asset: "USDT", available: "90.00", locked: "10.00", pending: "0", total: "100.00" };
const held: HeldIncoming[] = [
  { transfer_id: "a".repeat(24), amount: "4.00", available_at: "2026-09-30T10:00:00.123Z" },
  { transfer_id: "b".repeat(24), amount: "6.00", available_at: "2026-10-01T10:00:00.456Z" },
];

describe("held_incoming", () => {
  it("decodes held entries as sent (already inside locked)", async () => {
    const { client } = testClient({ replies: [ok([{ ...base, held_incoming: held }])] });
    const [b] = (await client.account.balances()) as [Balance];
    expect(b.held_incoming).toEqual(held);
    expect(b.locked).toBe("10.00");
  });

  it("keeps an empty list", async () => {
    const { client } = testClient({ replies: [ok({ ...base, held_incoming: [] })] });
    expect((await client.account.balance("USDT")).held_incoming).toEqual([]);
  });

  it("defaults to [] when a server omits the field", async () => {
    const { client } = testClient({ replies: [ok([base]), ok(base)] });
    expect((await client.account.balances())[0]!.held_incoming).toEqual([]);
    expect((await client.account.balance("USDT")).held_incoming).toEqual([]);
  });
});
