import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_ERROR_CODES, CexyApiError, CexyClient, isKnownErrorCode } from "../src/index.js";
import { json, ok, order, testClient, TEST_KEY, TEST_SECRET } from "./helpers.js";

const req = { symbol: "BTC/USDT", side: "buy", type: "limit", price: "60000.00", quantity: "0.001" } as const;

describe("redirects are never followed (mocked fetch)", () => {
  it("asks fetch for redirect: manual on every request", async () => {
    let seen: RequestRedirect | undefined;
    const client = new CexyClient({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      rateLimit: false,
      fetch: async (_url, init) => {
        seen = init.redirect;
        return ok({ order: order(), fills: [] });
      },
    });
    await client.trading.placeOrder(req);
    expect(seen).toBe("manual");
  });

  it.each([301, 302, 303, 307, 308])("a %i is an UNEXPECTED_REDIRECT error, not retried", async (status) => {
    const { client, calls, sleeps } = testClient({
      replies: [new Response(null, { status, headers: { location: "http://evil.invalid/steal" } })],
    });
    const err = await client.account.balances().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CexyApiError);
    expect(err).toMatchObject({ status, code: "UNEXPECTED_REDIRECT", retryable: false });
    expect(calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("a 307 on placeOrder is not re-posted and not treated as ambiguous", async () => {
    const { client, calls } = testClient({
      replies: [new Response(null, { status: 307, headers: { location: "https://other.invalid/api/v1/trading/orders" } })],
    });
    await expect(client.trading.placeOrder({ ...req, client_order_id: "cid-r" })).rejects.toMatchObject({
      code: "UNEXPECTED_REDIRECT",
    });
    // One POST, no retry and no lookup by client_order_id.
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("rejects a response that a custom fetch followed anyway", async () => {
    const client = new CexyClient({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      rateLimit: false,
      fetch: async () => {
        const followed = json(200, { data: [] });
        Object.defineProperty(followed, "redirected", { value: true });
        return followed;
      },
    });
    await expect(client.account.balances()).rejects.toMatchObject({ code: "UNEXPECTED_REDIRECT" });
  });
});

describe("redirects are never followed (real fetch, two local servers)", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function listen(handler: (req: IncomingMessage, status: (code: number, headers?: Record<string, string>) => void) => void) {
    const server = createServer((rq, rs) => {
      handler(rq, (code, headers = {}) => {
        rs.writeHead(code, { "content-type": "application/json", ...headers });
        rs.end(code < 300 ? JSON.stringify({ data: {} }) : "");
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it.each([
    ["GET", 302],
    ["POST", 307],
  ] as const)("%s answered with %i: the second origin receives nothing", async (method, code) => {
    const hits: { headers: IncomingMessage["headers"] }[] = [];
    const target = await listen((rq, send) => {
      hits.push({ headers: rq.headers });
      send(200);
    });
    const api = await listen((_rq, send) => send(code, { location: `${target}/collect` }));

    const client = new CexyClient({ apiKey: TEST_KEY, apiSecret: TEST_SECRET, baseUrl: api, allowInsecure: true, rateLimit: false });
    const call = method === "GET" ? client.account.balances() : client.trading.placeOrder(req);
    await expect(call).rejects.toMatchObject({ status: code, code: "UNEXPECTED_REDIRECT" });
    expect(hits).toEqual([]);
  });
});

it("UNEXPECTED_REDIRECT is exported as a client-side code, not a server code", () => {
  expect(CLIENT_ERROR_CODES.UNEXPECTED_REDIRECT).toBe("UNEXPECTED_REDIRECT");
  expect(isKnownErrorCode(CLIENT_ERROR_CODES.UNEXPECTED_REDIRECT)).toBe(false);
});
