import { describe, expect, it } from "vitest";
import { CexyConfigError, NotFoundError, type Balance, type HeldIncoming } from "../src/index.js";
import { json, ok, testClient } from "./helpers.js";

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

describe("subAccountBalances", () => {
  it("GETs the sub-account path (id encoded as one segment) with credentials", async () => {
    const { client, calls } = testClient({ replies: [ok([{ ...base, held_incoming: held }])] });
    const rows = await client.account.subAccountBalances("sub/1 ?x");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/api/v1/account/sub-accounts/sub%2F1%20%3Fx/balances");
    expect(calls[0]!.headers.get("x-api-key")).toBeTruthy();
    expect(calls[0]!.headers.get("idempotency-key")).toBeNull();
    expect(rows[0]!.held_incoming).toEqual(held);
  });

  it("defaults held_incoming to [] when the server omits it", async () => {
    const { client } = testClient({ replies: [ok([base])] });
    expect((await client.account.subAccountBalances("sub_1"))[0]!.held_incoming).toEqual([]);
  });

  it("maps 404 to NotFoundError, with exactly one request (no retry)", async () => {
    const { client, calls } = testClient({
      replies: [json(404, { error: { code: "NOT_FOUND", message: "no such sub-account", retryable: false } })],
    });
    await expect(client.account.subAccountBalances("other")).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toHaveLength(1);
  });

  it("rejects an empty id before any request", async () => {
    const { client, calls } = testClient();
    await expect(client.account.subAccountBalances("")).rejects.toBeInstanceOf(CexyConfigError);
    expect(calls).toHaveLength(0);
  });
});
