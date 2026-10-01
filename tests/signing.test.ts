/**
 * Request signing (planned scheme): cexy-api-spec/conformance/signing/vectors.json, plus a
 * RECORDING server that recomputes every signature from the raw request it received.
 */
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CexyApiError, CexyClient } from "../src/index.js";
import { HmacAuthenticator, canonicalPath, canonicalQuery, canonicalRequest, hmacSha256Hex, newNonce, sha256Hex } from "../src/signing.js";
import { json, loadJson, ok, testClient } from "./helpers.js";

interface RestCase {
  name: string;
  method: string;
  request_target: string;
  body: string;
  canonical_path: string;
  canonical_query: string;
  body_sha256: string;
  canonical_request: string;
  headers: Record<string, string>;
}
const V = loadJson<{
  key_id: string;
  secret: string;
  timestamp: string;
  nonce: string;
  rest: RestCase[];
  ws: { welcome: { connection_id: string; challenge: string }; message: string; auth_key: { key_id: string; signature: string } };
  negative: { canonical_request: string; wrong_secret: string; signature_with_right_secret: string; signature_with_wrong_secret: string };
}>("conformance/signing/vectors.json");

const split = (target: string): [string, string] => {
  const i = target.indexOf("?");
  return i < 0 ? [target, ""] : [target.slice(0, i), target.slice(i + 1)];
};

describe("conformance: signing/vectors.json", () => {
  const auth = new HmacAuthenticator(V.key_id, V.secret, { now: () => Number(V.timestamp), nonce: () => V.nonce });
  for (const c of V.rest) {
    it(c.name, async () => {
      const [path, query] = split(c.request_target);
      expect(canonicalPath(path)).toBe(c.canonical_path);
      expect(canonicalQuery(query)).toBe(c.canonical_query);
      expect(await sha256Hex(c.body)).toBe(c.body_sha256);
      expect(await canonicalRequest(c.method, path, query, V.timestamp, V.nonce, c.body)).toBe(c.canonical_request);
      const headers = new Headers({ "X-API-Secret": "must be removed" });
      const url = new URL(`https://api.cexy.io${c.request_target}`);
      await auth.authenticate({ method: c.method, url, headers, body: c.body === "" ? undefined : c.body });
      for (const [k, v] of Object.entries(c.headers)) expect(headers.get(k), k).toBe(v);
      expect(headers.has("X-API-Secret")).toBe(false);
    });
  }
  it("ws auth_key", async () => {
    const r = await auth.signWebSocketChallenge(V.ws.welcome.connection_id, V.ws.welcome.challenge);
    expect(r).toEqual({ keyId: V.ws.auth_key.key_id, signature: V.ws.auth_key.signature });
  });
  it("negative: only the right secret verifies", async () => {
    expect(await hmacSha256Hex(V.secret, V.negative.canonical_request)).toBe(V.negative.signature_with_right_secret);
    expect(await hmacSha256Hex(V.negative.wrong_secret, V.negative.canonical_request)).toBe(V.negative.signature_with_wrong_secret);
    expect(V.negative.signature_with_right_secret).not.toBe(V.negative.signature_with_wrong_secret);
  });
  it("nonce: 22 characters of base64url, fresh every time", () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newNonce()).not.toBe(a);
  });
});

// ---- a recording server: recomputes the signature from the RAW request ----------------------

interface Seen {
  method: string;
  rawTarget: string;
  body: Buffer;
  headers: IncomingMessage["headers"];
  valid: boolean;
}
let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

// An independent canonicaliser, written from the spec text (not the SDK's code), so the recording
// server catches canonicalisation bugs too.
const indepDecode = (s: string): Buffer =>
  Buffer.concat(
    s.split(/(%[0-9A-Fa-f]{2})/).map((p) => (/^%[0-9A-Fa-f]{2}$/.test(p) ? Buffer.from([parseInt(p.slice(1), 16)]) : Buffer.from(p, "utf8"))),
  );
const isUnreserved = (x: number): boolean =>
  (x >= 0x30 && x <= 0x39) || (x >= 0x41 && x <= 0x5a) || (x >= 0x61 && x <= 0x7a) || [0x2d, 0x2e, 0x5f, 0x7e].includes(x);
const indepEncode = (b: Buffer): string =>
  [...b].map((x) => (isUnreserved(x) ? String.fromCharCode(x) : `%${x.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
const indepPath = (path: string): string =>
  path
    .split("/")
    .map((seg) => indepEncode(indepDecode(seg)))
    .join("/");
const indepQuery = (query: string): string =>
  query
    .split("&")
    .filter((part) => part !== "")
    .map((part) => {
      const eq = part.indexOf("=");
      const [n, v] = eq < 0 ? [part, ""] : [part.slice(0, eq), part.slice(eq + 1)];
      return [indepEncode(indepDecode(n)), indepEncode(indepDecode(v))] as const;
    })
    .sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])) || Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1])))
    .map(([n, v]) => `${n}=${v}`)
    .join("&");

describe("independent canonicaliser", () => {
  it("agrees with the vectors, so the recording server's check is trustworthy", () => {
    for (const c of V.rest) {
      const [path, query] = split(c.request_target);
      expect(indepPath(path)).toBe(c.canonical_path);
      expect(indepQuery(query)).toBe(c.canonical_query);
    }
  });

  it("empty query parts are dropped and only the separator '?' is stripped (server rules)", () => {
    expect(canonicalQuery("a=1&&b=2&")).toBe("a=1&b=2");
    expect(indepQuery("a=1&&b=2&")).toBe("a=1&b=2");
    expect(canonicalQuery("?a=1")).toBe("%3Fa=1"); // the query of "/p??a=1"
    expect(indepQuery("?a=1")).toBe("%3Fa=1");
  });
});

/** An independent verifier (node:crypto and the canonicaliser above, not the SDK's code). */
function verify(method: string, rawTarget: string, body: Buffer, h: IncomingMessage["headers"]): boolean {
  const q = rawTarget.indexOf("?");
  const path = q < 0 ? rawTarget : rawTarget.slice(0, q);
  const query = q < 0 ? "" : rawTarget.slice(q + 1);
  const canonical = [
    "CEXY-HMAC-SHA256-v1",
    method,
    indepPath(path),
    indepQuery(query),
    String(h["x-api-timestamp"]),
    String(h["x-api-nonce"]),
    createHash("sha256").update(body).digest("hex"),
  ].join("\n");
  const expected = createHmac("sha256", V.secret).update(canonical).digest("hex");
  return expected === h["x-api-signature"] && Math.abs(Number(h["x-api-timestamp"]) - Date.now()) < 30_000;
}

async function recordingServer(reply: (req: Seen) => unknown) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const s: Seen = { method: req.method ?? "", rawTarget: req.url ?? "", body, headers: req.headers, valid: false };
      s.valid = verify(s.method, s.rawTarget, body, req.headers);
      seen.push(s);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: reply(s) }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen };
}

const ORDER = {
  id: "6aa9003697a77bccb95b2282", symbol: "BTC/USDT", side: "buy", type: "limit", status: "open", price: "1",
  quantity: "1", filled_quantity: "0", remaining_quantity: "1", client_order_id: "11111111-1111-1111-1111-111111111111",
  created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z", time_in_force: "gtc",
};

describe("recording server: what the transport sends is what was signed", () => {
  it("GET with a tricky query, POST JSON, DELETE, %2F path; never X-API-Secret", async () => {
    const { base, seen } = await recordingServer((s) =>
      s.rawTarget.startsWith("/api/v1/account/ledger") ? { items: [], next_cursor: null, has_more: false } : s.method === "POST" ? { order: ORDER, fills: [] } : ORDER,
    );
    const c = new CexyClient({ apiKey: V.key_id, apiSecret: V.secret, auth: "hmac", baseUrl: base, allowInsecure: true, rateLimit: false });
    await c.account.ledger({ asset: "Über €", cursor: "a b+c/d?e&f=g~h" });
    await c.trading.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "limit", quantity: "1", price: "1", client_order_id: ORDER.client_order_id } as never);
    await c.trading.cancelOrder(ORDER.id);
    await c.trading.orderByClientId("sub/1 ?x+y");
    expect(seen.map((s) => `${s.method} ${s.rawTarget.split("?")[0]}`)).toEqual([
      "GET /api/v1/account/ledger",
      "POST /api/v1/trading/orders",
      "DELETE /api/v1/trading/orders/6aa9003697a77bccb95b2282",
      "GET /api/v1/trading/orders/by-client-id/sub%2F1%20%3Fx%2By",
    ]);
    expect(seen[0]!.rawTarget).toContain("%20");
    expect(seen[0]!.rawTarget).not.toContain("+");
    for (const s of seen) {
      expect(s.valid, `${s.method} ${s.rawTarget}`).toBe(true);
      expect(s.headers["x-api-secret"]).toBeUndefined();
      expect(s.headers["x-api-key"]).toBe(V.key_id);
    }
    expect(JSON.parse(seen[1]!.body.toString("utf8")).client_order_id).toBe(ORDER.client_order_id);
  });

  it("signing is the default: no auth option signs, and the signature verifies", async () => {
    const { base, seen } = await recordingServer(() => []);
    const c = new CexyClient({ apiKey: V.key_id, apiSecret: V.secret, baseUrl: base, allowInsecure: true, rateLimit: false });
    await c.account.balances();
    expect(seen[0]!.valid).toBe(true);
    expect(seen[0]!.headers["x-api-secret"]).toBeUndefined();
  });

  it('auth: "headers" still sends X-API-Secret (for servers that accept it), with no signature', async () => {
    const { base, seen } = await recordingServer(() => []);
    const c = new CexyClient({ apiKey: V.key_id, apiSecret: V.secret, auth: "headers", baseUrl: base, allowInsecure: true, rateLimit: false });
    await c.account.balances();
    expect(seen[0]!.headers["x-api-secret"]).toBe(V.secret);
    expect(seen[0]!.headers["x-api-signature"]).toBeUndefined();
  });
});

describe("hmac transport rules", () => {
  it("SIGNATURE_REQUIRED (the API refuses the secret): names the fix and is never retried", async () => {
    const refused = { error: { code: "SIGNATURE_REQUIRED", message: "This API key must sign its requests; sending the secret is no longer accepted.", retryable: false } };
    const { client, calls } = testClient({ auth: "headers", replies: [json(400, refused)], fallback: ok([]) });
    const err = await client.account.balances().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CexyApiError);
    expect((err as CexyApiError).code).toBe("SIGNATURE_REQUIRED");
    expect((err as CexyApiError).message).toMatch(/auth: "hmac"/);
    expect((err as CexyApiError).retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("503 nonce_store_warming: waits Retry-After, re-signs, and leaves the clock offset alone", async () => {
    const warming = { error: { code: "SERVICE_UNAVAILABLE", message: "x", retryable: true, details: { reason: "nonce_store_warming" } } };
    const auth = new HmacAuthenticator(V.key_id, V.secret);
    const { client, calls, sleeps } = testClient({ creds: false, authenticator: auth, replies: [json(503, warming, { "retry-after": "2" }), ok([])] });
    await client.account.balances();
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(2000);
    expect(sleeps[0]!).toBeLessThanOrEqual(3000);
    expect(calls[0]!.headers.get("x-api-nonce")).not.toBe(calls[1]!.headers.get("x-api-nonce"));
    expect(auth.clockOffsetMs).toBe(0);
  });

  it("every retry re-signs with a fresh nonce", async () => {
    const { client, calls } = testClient({ auth: "hmac", replies: [json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "x", retryable: true } }), ok([])] });
    await client.account.balances();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.get("x-api-nonce")).not.toBe(calls[1]!.headers.get("x-api-nonce"));
    expect(calls.every((c) => !c.headers.has("x-api-secret"))).toBe(true);
  });

  it("SIGNATURE_EXPIRED: adopts the server clock and resends once, outside the retry budget", async () => {
    const serverNow = Date.now() + 120_000;
    const expired = () => json(401, { error: { code: "SIGNATURE_EXPIRED", message: "stale", retryable: false, details: { server_time_ms: serverNow } } });
    const { client, calls } = testClient({ auth: "hmac", maxRetries: 0, replies: [expired(), ok([])] });
    await client.account.balances();
    expect(calls).toHaveLength(2);
    const ts = Number(calls[1]!.headers.get("x-api-timestamp"));
    expect(Math.abs(ts - serverNow)).toBeLessThan(5_000);
    // A second SIGNATURE_EXPIRED is the error (no loop).
    const again = testClient({ auth: "hmac", maxRetries: 0, replies: [expired(), expired(), ok([])] });
    await expect(again.client.account.balances()).rejects.toMatchObject({ code: "SIGNATURE_EXPIRED" });
    expect(again.calls).toHaveLength(2);
  });

  it("SIGNATURE_EXPIRED beyond 1 h: a clear clock error, no resend", async () => {
    const reply = json(401, { error: { code: "SIGNATURE_EXPIRED", message: "stale", retryable: false, details: { server_time_ms: Date.now() + 2 * 3600_000 } } });
    const { client, calls } = testClient({ auth: "hmac", replies: [reply] });
    await expect(client.account.balances()).rejects.toThrow(/local clock is more than 1 hour/);
    expect(calls).toHaveLength(1);
  });

  it("KEY_NOT_SIGNABLE: names the fix and never falls back to X-API-Secret", async () => {
    const reply = json(401, { error: { code: "KEY_NOT_SIGNABLE", message: "old key", retryable: false } });
    const { client, calls } = testClient({ auth: "hmac", replies: [reply], fallback: ok([]) });
    const err = await client.account.balances().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CexyApiError);
    expect((err as CexyApiError).message).toBe("create a new API key; keys issued before request signing can't sign");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.has("x-api-secret")).toBe(false);
  });

  it("the secret never appears in logs, errors or serialisation", () => {
    const a = new HmacAuthenticator(V.key_id, V.secret);
    expect(String(a) + JSON.stringify(a)).not.toContain(V.secret);
    expect(a.redact(`boom ${V.secret}`)).not.toContain(V.secret);
  });
});
