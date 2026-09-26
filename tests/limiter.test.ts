import { afterEach, describe, expect, it, vi } from "vitest";
import { CexyClient, RateLimiter } from "../src/index.js";
import { mockFetch, ok } from "./helpers.js";

function clock() {
  let now = 1_790_000_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

describe("client-side rate limiter", () => {
  it("defaults to 300/min: the 301st immediate request waits ~200 ms", async () => {
    const c = clock();
    const l = new RateLimiter({ requestsPerMinute: 300, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 300; i++) await l.acquire();
    expect(c.sleeps.length).toBe(0);
    await l.acquire();
    expect(c.sleeps).toEqual([200]);
  });

  it("adapts to X-RateLimit-Limit (never upwards) and X-RateLimit-Remaining", () => {
    const c = clock();
    const l = new RateLimiter({ requestsPerMinute: 300, now: c.now, sleep: c.sleep });
    l.update(new Headers({ "X-RateLimit-Limit": "600", "X-RateLimit-Remaining": "599" }));
    expect(l.state.requestsPerMinute).toBe(300);
    l.update(new Headers({ "X-RateLimit-Limit": "120", "X-RateLimit-Remaining": "7" }));
    expect(l.state.requestsPerMinute).toBe(120);
    expect(l.state.tokens).toBe(7);
  });

  it("Remaining: 0 blocks until X-RateLimit-Reset (seconds or epoch)", async () => {
    const c = clock();
    const l = new RateLimiter({ requestsPerMinute: 300, now: c.now, sleep: c.sleep });
    l.update(new Headers({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "5" }));
    await l.acquire();
    expect(c.sleeps[0]).toBe(5000);

    const c2 = clock();
    const l2 = new RateLimiter({ requestsPerMinute: 300, now: c2.now, sleep: c2.sleep });
    l2.update(new Headers({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(c2.now() / 1000) + 3) }));
    await l2.acquire();
    expect(c2.sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(c2.sleeps[0]).toBeLessThanOrEqual(3000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("end to end: the client waits after a response says the window is used up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sleeps: number[] = [];
    const m = mockFetch([ok([], { "X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "4" })], ok([]));
    const client = new CexyClient({
      fetch: m.fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
        vi.setSystemTime(Date.now() + ms);
      },
    });
    await client.markets.list();
    expect(sleeps).toEqual([]);
    await client.markets.list();
    expect(sleeps).toEqual([4000]);
    expect(m.calls.length).toBe(2);
  });

  it("defaults to 100/min anonymous and 300/min with a key", () => {
    const anon = new CexyClient({ fetch: mockFetch().fetch });
    expect(anon.rateLimit?.requestsPerMinute).toBe(100);
    const keyed = new CexyClient({ fetch: mockFetch().fetch, apiKey: "ak_test_key", apiSecret: "test_secret" });
    expect(keyed.rateLimit?.requestsPerMinute).toBe(300);
    const custom = new CexyClient({ fetch: mockFetch().fetch, rateLimit: { requestsPerMinute: 50 } });
    expect(custom.rateLimit?.requestsPerMinute).toBe(50);
    expect(new CexyClient({ fetch: mockFetch().fetch, rateLimit: false }).rateLimit).toBeNull();
  });

  it("can be disabled", async () => {
    const m = mockFetch([], ok([]));
    const client = new CexyClient({ fetch: m.fetch, rateLimit: false });
    await Promise.all(Array.from({ length: 5 }, () => client.markets.list()));
    expect(m.calls.length).toBe(5);
  });
});
