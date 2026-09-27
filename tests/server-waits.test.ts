import { describe, expect, it } from "vitest";
import { CexyClient, MAX_SERVER_WAIT_MS, RateLimitError, RateLimiter } from "../src/index.js";
import { json, loadJson, mockFetch } from "./helpers.js";

interface Item {
  http_status: number;
  headers?: Record<string, string>;
  body?: unknown;
  error?: unknown;
}
interface Case {
  id: string;
  responses: Item[];
  then_calls?: number;
  expect: {
    calls: number;
    sleeps_s?: number[];
    ok?: boolean;
    error_code?: string;
    retry_after_s?: number;
    no_sleep_longer_than_s?: number;
  };
}

const conformance = loadJson<{ max_server_wait_s: number; cases: Case[] }>("conformance/transport/server_waits.json");

function reply(i: Item): Response {
  return json(i.http_status, i.body ?? { error: i.error }, i.headers ?? {});
}

describe("server-controlled waits: shared conformance cases", () => {
  it("MAX_SERVER_WAIT_MS matches the shared limit", () => {
    expect(MAX_SERVER_WAIT_MS).toBe(conformance.max_server_wait_s * 1000);
  });

  it.each(conformance.cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const items = c.responses;
    const m = mockFetch(items.map(reply), () => reply(items[items.length - 1]!));
    let t = 1_000_000;
    const sleeps: number[] = [];
    const client = new CexyClient({
      fetch: m.fetch,
      random: () => 0.5,
      now: () => t,
      sleep: async (ms) => {
        expect(Number.isFinite(ms)).toBe(true);
        sleeps.push(ms);
        t += ms;
      },
    });
    const e = c.expect;
    let error: unknown = null;
    for (let i = 0; i <= (c.then_calls ?? 0); i++) {
      try {
        await client.time();
      } catch (err) {
        error = err;
      }
    }
    expect(m.calls.length).toBe(e.calls);
    if (e.ok) expect(error).toBeNull();
    if (e.error_code) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).code).toBe(e.error_code);
    }
    if (e.retry_after_s !== undefined) expect((error as RateLimitError).retryAfterMs).toBe(e.retry_after_s * 1000);
    if (e.sleeps_s) {
      expect(sleeps).toHaveLength(e.sleeps_s.length);
      e.sleeps_s.forEach((s, i) => {
        expect(sleeps[i]).toBeGreaterThanOrEqual(s * 1000);
        expect(sleeps[i]).toBeLessThanOrEqual(s * 1000 + 1000);
      });
    }
    if (e.no_sleep_longer_than_s !== undefined) {
      for (const s of sleeps) expect(s).toBeLessThanOrEqual(e.no_sleep_longer_than_s * 1000);
    }
  });
});

describe("RateLimiter and server hints", () => {
  it("ignores non-finite blocks, caps long ones at 120 s and ignores a sub-1/min limit", () => {
    const t = 0;
    const rl = new RateLimiter({ requestsPerMinute: 100, now: () => t });
    rl.blockFor(Number.POSITIVE_INFINITY);
    rl.blockFor(Number.NaN);
    expect(rl.state.blockedUntil).toBe(0);
    rl.blockFor(86_400_000);
    expect(rl.state.blockedUntil).toBe(120_000);
    rl.update(new Headers({ "X-RateLimit-Limit": "0.0001" }));
    expect(rl.state.requestsPerMinute).toBe(100);
  });
});
