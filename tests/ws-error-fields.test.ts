/** Server `error` frames: the optional `channel` / `details` fields, and their tolerance of bad types. */
import { afterEach, describe, expect, it } from "vitest";
import { CexyWebSocket, CexyWebSocketError } from "../src/index.js";
import { startFakeServer } from "./ws-server.js";

type Server = Awaited<ReturnType<typeof startFakeServer>>;
let srv: Server | null = null;
let ws: CexyWebSocket | null = null;
afterEach(async () => {
  ws?.close();
  ws = null;
  await srv?.close();
  srv = null;
});

/** Sends one server frame and returns the `serverError` payload it produced. */
async function errorFor(frame: Record<string, unknown>) {
  srv = await startFakeServer({ auth: "silent" });
  ws = new CexyWebSocket({ url: srv.url, allowInsecure: true });
  const got: { err: CexyWebSocketError; frame: Record<string, unknown> }[] = [];
  ws.on("serverError", (err, f) => got.push({ err, frame: f as unknown as Record<string, unknown> }));
  ws.on("error", () => {});
  await ws.connect();
  srv.conns[0]!.send({ type: "error", code: "RATE_LIMITED", message: "m", ...frame });
  await srv.until(() => got.length === 1, "serverError");
  return got[0]!;
}

describe("WS error frame optional fields", () => {
  it("channel and details.retry_after_seconds are exposed", async () => {
    const { err, frame } = await errorFor({ channel: "futures.orderbook:NOPE", details: { retry_after_seconds: 60 } });
    expect(err.fromServer).toBe(true);
    expect(err.channel).toBe("futures.orderbook:NOPE");
    expect(err.details).toEqual({ retry_after_seconds: 60 });
    expect(err.retryAfterMs).toBe(60_000);
    expect(frame["channel"]).toBe("futures.orderbook:NOPE");
    expect(frame["retryAfterMs"]).toBe(60_000);
  });

  it("a frame without them leaves the fields empty", async () => {
    const { err, frame } = await errorFor({});
    expect(err.channel).toBeUndefined();
    expect(err.details).toBeUndefined();
    expect(err.retryAfterMs).toBeUndefined();
    expect(frame).not.toHaveProperty("channel");
  });

  it("details null (or not an object) gives empty details and no error", async () => {
    for (const details of [null, "x", ["retry_after_seconds", 5]]) {
      const { err } = await errorFor({ details });
      expect(err.details).toBeUndefined();
      expect(err.retryAfterMs).toBeUndefined();
      ws?.close();
      await srv?.close();
    }
  });

  it("retry_after_seconds that is not a number, or is negative, gives no retryAfterMs", async () => {
    for (const v of ["60", -1, null]) {
      const { err } = await errorFor({ details: { retry_after_seconds: v } });
      expect(err.details).toEqual({ retry_after_seconds: v });
      expect(err.retryAfterMs).toBeUndefined();
      ws?.close();
      await srv?.close();
    }
  });

  it("an unknown extra key still decodes", async () => {
    const { err } = await errorFor({ future_field: { a: 1 }, channel: "ticker:A/USDT" });
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.channel).toBe("ticker:A/USDT");
  });

  it("local errors leave the fields empty", () => {
    const e = new CexyWebSocketError("CONFIG", "x");
    expect(e.fromServer).toBe(false);
    expect(e.channel).toBeUndefined();
    expect(e.details).toBeUndefined();
    expect(e.retryAfterMs).toBeUndefined();
  });
});
