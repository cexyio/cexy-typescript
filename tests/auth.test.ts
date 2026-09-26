import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  ApiKeyAuthenticator,
  AuthenticationError,
  CexyApiError,
  CexyClient,
  CexyConfigError,
  ForbiddenError,
  OPERATIONS,
  type OperationId,
} from "../src/index.js";
import { json, loadJson, mockFetch, ok, testClient, TEST_KEY, TEST_SECRET } from "./helpers.js";
import { INVOKE, opIdFor } from "./invoke.js";

interface AuthCase {
  id: string;
  request?: { operation: string };
  client?: { api_key: string | null; api_secret: string | null };
  expect: Record<string, any>;
}
const conformance = loadJson<{ cases: AuthCase[]; server_responses: any[] }>("conformance/auth.json");

/** The conformance files use language-neutral class names. */
const ERROR_CLASSES: Record<string, new (...a: any[]) => CexyApiError> = {
  AuthenticationError,
  PermissionError: ForbiddenError,
  ForbiddenError,
  CexyApiError,
};

describe("conformance/auth.json cases", () => {
  it("has the cases this suite knows how to run", () => {
    expect(conformance.cases.map((c) => c.id).sort()).toEqual(
      ["half_pair_rejected_locally", "key_headers_on_private", "never_in_url", "no_credentials_on_public", "redaction", "user_agent"].sort(),
    );
  });

  for (const c of conformance.cases) {
    it(c.id, async () => {
      if (c.client) {
        const m = mockFetch();
        const make = () =>
          new CexyClient({
            apiKey: c.client!.api_key ?? undefined,
            apiSecret: c.client!.api_secret ?? undefined,
            fetch: m.fetch,
          });
        if (c.expect.construct_error) expect(make).toThrow(CexyConfigError);
        expect(m.calls.length).toBe(c.expect.requests_sent ?? 0);
        return;
      }

      const op = opIdFor(c.request!.operation, OPERATIONS);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const { client, calls } = testClient({
        replies: [c.id === "redaction" ? json(401, { error: { code: "UNAUTHENTICATED", message: `bad key ${TEST_KEY} / ${TEST_SECRET}`, retryable: false } }) : ok([])],
      });
      let thrown: unknown;
      try {
        await INVOKE[op](client);
      } catch (e) {
        thrown = e;
      }
      const req = calls[0]!;
      const e = c.expect;
      for (const h of e.headers_present ?? []) expect(req.headers.get(h), h).toBeTruthy();
      for (const h of e.headers_absent ?? []) expect(req.headers.has(h), h).toBe(false);
      for (const s of e.url_must_not_contain ?? []) expect(req.url.toString()).not.toContain(s);
      for (const [h, re] of Object.entries<string>(e.header_matches ?? {})) expect(req.headers.get(h)).toMatch(new RegExp(re));
      if (e.secret_not_in) {
        const surfaces = [
          String(client),
          inspect(client, { depth: 10 }),
          JSON.stringify(client),
          inspect(client.trading, { depth: 10, showHidden: true }),
          JSON.stringify(client.trading),
          String(thrown),
          inspect(thrown, { depth: 10 }),
          JSON.stringify(thrown),
          (thrown as Error).message,
          (thrown as Error).stack ?? "",
          ...warn.mock.calls.flat().map(String),
          ...log.mock.calls.flat().map(String),
        ];
        expect(thrown).toBeInstanceOf(AuthenticationError);
        for (const s of surfaces) {
          expect(s).not.toContain(TEST_SECRET);
          expect(s).not.toContain(TEST_KEY);
        }
      }
      warn.mockRestore();
      log.mockRestore();
    });
  }
});

describe("conformance/auth.json server responses", () => {
  for (const r of conformance.server_responses) {
    it(`${r.id} -> ${r.expect.error_class}`, async () => {
      const { client, calls } = testClient({ replies: [json(r.status, r.body)] });
      const err = await client.account.balances().catch((e: unknown) => e);
      const cls = ERROR_CLASSES[r.expect.error_class];
      expect(cls, `class mapping for ${r.expect.error_class}`).toBeDefined();
      expect(err).toBeInstanceOf(cls!);
      expect((err as CexyApiError).code).toBe(r.body.error.code);
      expect(calls.length).toBe(1); // not retryable
    });
  }
});

describe("credentials placement", () => {
  const ids = Object.keys(OPERATIONS) as OperationId[];

  it("never sends key headers on any public operation, and always on private ones", async () => {
    for (const id of ids) {
      const { client, calls } = testClient({ fallback: (req) => (req.url.pathname.startsWith("/api/v1/exports") ? new Response("a,b\n") : ok({ items: [], has_more: false })) });
      await INVOKE[id](client).catch(() => {});
      const req = calls[0]!;
      expect(req.headers.has("Authorization"), id).toBe(false);
      if (OPERATIONS[id].auth === "none") {
        expect(req.headers.has("X-API-Key"), id).toBe(false);
        expect(req.headers.has("X-API-Secret"), id).toBe(false);
      } else {
        expect(req.headers.get("X-API-Key"), id).toBe(TEST_KEY);
        expect(req.headers.get("X-API-Secret"), id).toBe(TEST_SECRET);
      }
      expect(req.url.toString()).not.toContain(TEST_SECRET);
    }
  });

  it("refuses private operations locally without credentials (0 requests)", async () => {
    const { client, calls } = testClient({ creds: false });
    await expect(client.account.balances()).rejects.toBeInstanceOf(CexyConfigError);
    expect(calls.length).toBe(0);
    await client.markets.list();
    expect(calls[0]!.headers.has("X-API-Key")).toBe(false);
  });

  it("rejects half pairs and key+authenticator combos at construction", () => {
    expect(() => new CexyClient({ apiKey: TEST_KEY })).toThrow(CexyConfigError);
    expect(() => new CexyClient({ apiSecret: TEST_SECRET })).toThrow(CexyConfigError);
    expect(() => new CexyClient({ apiKey: TEST_KEY, apiSecret: "" })).toThrow(/together/);
    expect(
      () => new CexyClient({ apiKey: TEST_KEY, apiSecret: TEST_SECRET, authenticator: new ApiKeyAuthenticator(TEST_KEY, TEST_SECRET) }),
    ).toThrow(CexyConfigError);
    expect(() => new CexyClient({ baseUrl: "https://u:p@example.invalid" })).toThrow(CexyConfigError);
  });

  it("half-pair error message does not echo the value", () => {
    try {
      new CexyClient({ apiKey: TEST_KEY });
    } catch (e) {
      expect(String(e)).not.toContain(TEST_KEY);
    }
  });

  it("redacts the authenticator itself", () => {
    const a = new ApiKeyAuthenticator(TEST_KEY, TEST_SECRET);
    for (const s of [String(a), inspect(a), JSON.stringify(a), inspect(a, { showHidden: true, depth: 5 })]) {
      expect(s).not.toContain(TEST_SECRET);
      expect(s).not.toContain(TEST_KEY);
    }
    expect(a.redact(`x ${TEST_SECRET} y`)).toBe("x [REDACTED] y");
  });

  it("supports a pluggable authenticator (future signing) called on every attempt", async () => {
    const seen: string[] = [];
    const authenticator = {
      kind: "test-signer",
      authenticate: (r: { headers: Headers; method: string; url: URL }) => {
        seen.push(`${r.method} ${r.url.pathname}`);
        r.headers.set("X-Test-Signature", String(seen.length));
      },
      redact: (t: string) => t,
    };
    const m = mockFetch([json(503, { error: { code: "SERVICE_UNAVAILABLE", message: "x", retryable: true } }), ok([])]);
    const client = new CexyClient({ authenticator, fetch: m.fetch, sleep: async () => {}, rateLimit: false });
    await client.account.balances();
    await client.markets.list();
    expect(seen).toEqual(["GET /api/v1/account/balances", "GET /api/v1/account/balances"]);
    expect(m.calls[1]!.headers.get("X-Test-Signature")).toBe("2");
    expect(m.calls[2]!.headers.has("X-Test-Signature")).toBe(false);
  });
});
