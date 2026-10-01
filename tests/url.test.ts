import { describe, expect, it } from "vitest";
import { CexyClient, CexyConfigError, CexyWebSocket, CexyWebSocketError } from "../src/index.js";
import { OPERATIONS } from "../src/operations.js";
import { Transport } from "../src/http.js";
import { stripTrailingSlashes } from "../src/url.js";
import { mockFetch, ok, testClient } from "./helpers.js";

const f = () => mockFetch().fetch;

describe("transport security: https:// and wss:// only", () => {
  it("rejects http:// baseUrl without allowInsecure, even for localhost", () => {
    expect(() => new CexyClient({ fetch: f(), baseUrl: "http://api.cexy.io" })).toThrow(CexyConfigError);
    expect(() => new CexyClient({ fetch: f(), baseUrl: "http://localhost" })).toThrow(/allowInsecure/);
  });

  it("allowInsecure permits http:// only for loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(() => new CexyClient({ fetch: f(), baseUrl: `http://${host}`, allowInsecure: true })).not.toThrow();
    }
    for (const host of ["api.cexy.io", "example.invalid", "localhost.example.com", "127.0.0.2"]) {
      expect(() => new CexyClient({ fetch: f(), baseUrl: `http://${host}`, allowInsecure: true }), host).toThrow(CexyConfigError);
    }
  });

  it("rejects other schemes", () => {
    expect(() => new CexyClient({ fetch: f(), baseUrl: "ftp://api.cexy.io" })).toThrow(CexyConfigError);
    expect(() => new CexyClient({ fetch: f(), baseUrl: "not a url" })).toThrow(CexyConfigError);
  });

  it("WebSocket url must be wss:// unless allowInsecure and loopback", () => {
    expect(() => new CexyWebSocket({ url: "wss://api.cexy.io/api/v1/ws" })).not.toThrow();
    expect(() => new CexyWebSocket({ url: "ws://api.cexy.io/api/v1/ws" })).toThrow(CexyWebSocketError);
    expect(() => new CexyWebSocket({ url: "ws://localhost/api/v1/ws" })).toThrow(/allowInsecure/);
    expect(() => new CexyWebSocket({ url: "ws://api.cexy.io/api/v1/ws", allowInsecure: true })).toThrow(/localhost/);
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(() => new CexyWebSocket({ url: `ws://${host}/api/v1/ws`, allowInsecure: true })).not.toThrow();
    }
    expect(() => new CexyWebSocket({ url: "https://api.cexy.io/api/v1/ws" })).toThrow(CexyWebSocketError);
  });

  it("client.websocket() derives wss:// and inherits allowInsecure", () => {
    expect(new CexyClient({ fetch: f() }).websocket().url).toBe("wss://api.cexy.io/api/v1/ws");
    const local = new CexyClient({ fetch: f(), baseUrl: "http://127.0.0.1", allowInsecure: true });
    expect(local.websocket().url).toBe("ws://127.0.0.1/api/v1/ws");
    expect(() => new CexyClient({ fetch: f() }).websocket({ url: "ws://127.0.0.1/api/v1/ws" })).toThrow(CexyWebSocketError);
  });
});

describe("path values stay one segment", () => {
  const t = new Transport({
    baseUrl: "https://api.cexy.io",
    timeoutMs: 1000,
    maxRetries: 0,
    fetch: f(),
    authenticator: null,
    limiter: null,
    userAgent: null,
    sleep: async () => {},
    random: () => 0.5,
  });
  const build = (id: string) => t.buildUrl(OPERATIONS.sub_account_balances, { id });

  it("the builder rejects \".\" and \"..\" (the URL layer would resolve them, even as %2E)", () => {
    expect(() => build(".")).toThrow(CexyConfigError);
    expect(() => build("..")).toThrow(/must not be "." or ".."/);
  });

  it("other values, dots included, are encoded into exactly one segment", () => {
    const cases: Array<[string, string]> = [
      ["a/b", "a%2Fb"],
      ["%2F", "%252F"],
      ["a?b", "a%3Fb"],
      ["a#b", "a%23b"],
      ["é✓", "%C3%A9%E2%9C%93"],
      ["%2e%2e", "%252e%252e"],
      ["a b", "a%20b"],
      ["...", "..."],
      [".a", ".a"],
    ];
    for (const [id, seg] of cases) {
      const url = build(id);
      expect(url.pathname, id).toBe(`/api/v1/account/sub-accounts/${seg}/balances`);
      expect(url.search, id).toBe("");
      expect(url.hash, id).toBe("");
    }
  });

  it("a GET and a mutation reject \".\" and \"..\" with no request", async () => {
    const { client, calls } = testClient({ fallback: ok({}) });
    for (const v of [".", ".."]) {
      await expect(client.trading.orderByClientId(v)).rejects.toBeInstanceOf(CexyConfigError);
      await expect(client.trading.cancelOrder(v)).rejects.toBeInstanceOf(CexyConfigError);
      await expect(client.pools.join(v, { base_amount: "1", quote_amount: "2" })).rejects.toBeInstanceOf(CexyConfigError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("stripTrailingSlashes", () => {
  it("removes only trailing slashes", () => {
    expect(stripTrailingSlashes("https://api.cexy.io///")).toBe("https://api.cexy.io");
    expect(stripTrailingSlashes("https://api.cexy.io")).toBe("https://api.cexy.io");
    expect(stripTrailingSlashes("https://x/a/b/")).toBe("https://x/a/b");
    expect(stripTrailingSlashes("///")).toBe("");
    expect(stripTrailingSlashes("")).toBe("");
  });

  it("stays fast on ~100k slashes that are not at the end (the old /\\/+$/ was polynomial)", () => {
    const hostile = "https://api.cexy.io" + "/".repeat(100_000) + "x";
    const t0 = performance.now();
    expect(stripTrailingSlashes(hostile)).toBe(hostile);
    expect(stripTrailingSlashes("https://api.cexy.io" + "/".repeat(100_000))).toBe("https://api.cexy.io");
    expect(() => new CexyClient({ baseUrl: hostile })).not.toThrow(/timeout/);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
