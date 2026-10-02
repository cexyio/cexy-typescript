import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATIONS, VERSION, type OperationId } from "../src/index.js";
import { json, loadJson, ok, testClient } from "./helpers.js";
import { INVOKE } from "./invoke.js";

const spec = loadJson<any>("spec/openapi.sdk.json");

/** Text that must never reach the published types: internal notes and old spec metadata. */
const BANNED_IN_GENERATED = [
  "legacy",
  "finding S\\d",
  "ambiguity A\\d",
  "docs/[\\w-]+\\.md",
  "Proprietary",
  "Exchange API",
];
const specOps: { id: string; method: string; path: string; scope: string | null; keyAuth: boolean }[] = [];
for (const [path, item] of Object.entries<any>(spec.paths)) {
  for (const [method, op] of Object.entries<any>(item)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    specOps.push({
      id: op.operationId,
      method: method.toUpperCase(),
      path,
      scope: op["x-required-scope"] ?? null,
      keyAuth: (op.security ?? []).some((s: Record<string, unknown>) => "api_key" in s),
    });
  }
}

describe("SDK surface covers exactly spec/openapi.sdk.json", () => {
  it("has 51 operations in the spec and in the SDK", () => {
    expect(specOps.length).toBe(51);
    expect(Object.keys(OPERATIONS).length).toBe(51);
  });

  it("operation ids, methods, paths, auth and scopes match the spec", () => {
    const sdk = Object.entries(OPERATIONS).map(([id, o]) => ({
      id,
      method: o.method,
      path: o.path,
      scope: o.scope === null ? null : o.scope,
      keyAuth: o.auth === "api_key",
    }));
    const norm = (xs: { id: string }[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
    expect(norm(sdk)).toEqual(norm(specOps.map((o) => ({ ...o, scope: o.scope === "-" ? null : o.scope }))));
  });

  it("every operation is reachable through the facade and hits the right method + path", async () => {
    const seen = new Set<string>();
    for (const id of Object.keys(OPERATIONS) as OperationId[]) {
      const { client, calls } = testClient({
        fallback: (r) =>
          r.url.pathname.startsWith("/api/v1/exports") ? new Response("id,amount\n", { headers: { "content-type": "text/csv" } }) : ok({}),
      });
      await INVOKE[id](client);
      expect(calls.length, id).toBe(1);
      const c = calls[0]!;
      const o = OPERATIONS[id];
      const pattern = new RegExp("^" + o.path.replace(/\{\w+\}/g, "[^/]+") + "$");
      expect(c.method, id).toBe(o.method);
      expect(c.url.pathname, id).toMatch(pattern);
      expect(c.url.origin).toBe("https://api.cexy.io");
      seen.add(`${c.method} ${o.path}`);
      // The facade method named in the table exists.
      const [ns, fn] = o.sdkMethod.includes(".") ? o.sdkMethod.split(".") : [undefined, o.sdkMethod];
      const target: any = ns ? (client as any)[ns] : client;
      expect(typeof target[fn], o.sdkMethod).toBe("function");
    }
    expect(seen.size).toBe(51);
  });

  it("generated types carry no implementation notes or stale spec metadata", () => {
    const schema = readFileSync(resolve(__dirname, "../src/generated/schema.ts"), "utf8");
    for (const banned of BANNED_IN_GENERATED) expect(schema).not.toMatch(new RegExp(banned, "i"));
  });

  it("path parameters are URL-encoded (BTC/USDT -> BTC%2FUSDT)", async () => {
    const { client, calls } = testClient({ fallback: ok({}) });
    await client.markets.get("BTC/USDT");
    expect(calls[0]!.url.pathname).toBe("/api/v1/markets/BTC%2FUSDT");
  });

  it("exports return CSV text", async () => {
    const { client } = testClient({ fallback: new Response("id,amount\n1,2\n", { headers: { "content-type": "text/csv" } }) });
    expect(await client.exports.orders()).toBe("id,amount\n1,2\n");
  });

  it("unwraps {data} and passes pages through", async () => {
    const { client } = testClient({ replies: [ok([{ symbol: "BTC/USDT" }]), json(200, { items: [], has_more: false })] });
    expect(await client.markets.list()).toEqual([{ symbol: "BTC/USDT" }]);
    expect(await client.trading.orderHistory()).toEqual({ items: [], has_more: false });
  });
});

describe("User-Agent and version", () => {
  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
    expect(VERSION).toBe(pkg.version);
    expect(pkg.name).toBe("@cexyio/cexy");
  });

  it("sends cexy-typescript/<version> (plus an optional suffix)", async () => {
    const a = testClient({ creds: false });
    await a.client.time().catch(() => {});
    expect(a.calls[0]!.headers.get("User-Agent")).toBe(`cexy-typescript/${VERSION}`);
    const b = testClient({ creds: false, userAgentSuffix: "cexy-mcp/0.1.0" });
    await b.client.time().catch(() => {});
    expect(b.calls[0]!.headers.get("User-Agent")).toBe(`cexy-typescript/${VERSION} cexy-mcp/0.1.0`);
  });

  it("defaults to https://api.cexy.io and honours baseUrl", async () => {
    const a = testClient({ creds: false, baseUrl: "https://example.invalid/" });
    await a.client.time().catch(() => {});
    expect(a.calls[0]!.url.toString()).toBe("https://example.invalid/api/v1/time");
  });
});
