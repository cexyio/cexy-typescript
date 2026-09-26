import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CexyClient, type CexyClientOptions } from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The sibling spec repo: ../cexy-api-spec (override with CEXY_API_SPEC_DIR). */
export const SPEC_DIR = resolve(repoRoot, process.env.CEXY_API_SPEC_DIR ?? "../cexy-api-spec");
export const CONFORMANCE_DIR = resolve(SPEC_DIR, "conformance");

export function loadJson<T = any>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(SPEC_DIR, relPath), "utf8")) as T;
}

export const TEST_KEY = "ak_test_key";
export const TEST_SECRET = "test_secret";

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: any;
}

export type Reply = Response | Error | ((req: RecordedRequest) => Response | Error | Promise<Response | Error>);

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export const ok = (data: unknown, headers: Record<string, string> = {}) => json(200, { data }, headers);

/**
 * A fetch mock. `replies` are consumed in order; when exhausted, `fallback` answers.
 * Every request is recorded in `calls`.
 */
export function mockFetch(replies: Reply[] = [], fallback: Reply = () => ok({})) {
  const calls: RecordedRequest[] = [];
  const queue = [...replies];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const req: RecordedRequest = { method: init.method ?? "GET", url: new URL(input), headers, body };
    calls.push(req);
    const next = queue.length ? queue.shift()! : fallback;
    const r = typeof next === "function" ? await next(req) : next;
    if (r instanceof Error) throw r;
    return r.clone();
  };
  return { fetch, calls };
}

/** A client wired to a fetch mock, with instant sleeps (recorded) and deterministic jitter. */
export function testClient(opts: Partial<CexyClientOptions> & { replies?: Reply[]; fallback?: Reply; creds?: boolean } = {}) {
  const { replies, fallback, creds = true, ...rest } = opts;
  const m = mockFetch(replies, fallback);
  const sleeps: number[] = [];
  const client = new CexyClient({
    ...(creds ? { apiKey: TEST_KEY, apiSecret: TEST_SECRET } : {}),
    fetch: m.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    rateLimit: false,
    ...rest,
  });
  return { client, calls: m.calls, sleeps };
}

export function networkError(): Error {
  return new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
}

export function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "ord_1",
    symbol: "BTC/USDT",
    side: "buy",
    type: "limit",
    time_in_force: "gtc",
    status: "open",
    price: "60000.00",
    quantity: "0.001",
    filled_quantity: "0",
    remaining_quantity: "0.001",
    filled_quote_quantity: "0",
    fee_paid: "0",
    reserved_remaining: "60.06",
    created_at: "2026-09-26T00:00:00Z",
    updated_at: "2026-09-26T00:00:00Z",
    ...overrides,
  };
}
