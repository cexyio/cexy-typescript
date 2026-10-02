/** Futures WebSocket channels: conformance/ws/futures.json against the local fake server. */
import { afterEach, describe, expect, it } from "vitest";
import {
  CexyWebSocket,
  CexyWebSocketError,
  DEFAULT_PING_INTERVAL_MS,
  MAX_PING_INTERVAL_MS,
  futuresChannel,
  type FuturesInterval,
  type SubscribeResult,
  type WsEvent,
} from "../src/index.js";
import { HmacAuthenticator } from "../src/signing.js";
import { loadJson } from "./helpers.js";
import { startFakeServer, ticks } from "./ws-server.js";

interface Step {
  client?: "subscribe" | "auth_key";
  channels?: string[];
  server?: Record<string, unknown>;
  server_reply_to?: "subscribe" | "unsubscribe";
  frame?: Record<string, unknown>;
}
interface Scenario {
  id: string;
  steps: Step[];
  expect: {
    events?: string[];
    resync_channels?: string[];
    client_sends_after?: { op: string; channels?: string[] }[];
    errors?: string[];
    held_channels_after?: string[];
    held_pending_private?: string[];
  };
}
interface FrameCase {
  id: string;
  frame: Record<string, any>;
  expect: Record<string, unknown>;
}
const F = loadJson<{
  frames: FrameCase[];
  channel_names: { valid: [string, string[], string][]; invalid: [string, string[]][] };
  scenarios: Scenario[];
  ping_interval_max_seconds: number;
}>("conformance/ws/futures.json");
const V = loadJson<{ key_id: string; secret: string }>("conformance/signing/vectors.json");
const signer = new HmacAuthenticator(V.key_id, V.secret);

type Server = Awaited<ReturnType<typeof startFakeServer>>;
let srv: Server | null = null;
let ws: CexyWebSocket | null = null;
afterEach(async () => {
  ws?.close();
  ws = null;
  await srv?.close();
  srv = null;
});

async function connect(): Promise<{ srv: Server; ws: CexyWebSocket }> {
  srv = await startFakeServer({ ackSubscribe: false, ackUnsubscribe: false, auth: "silent", welcome: { challenge: "c-1" } });
  ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, keySigner: signer });
  await ws.connect();
  return { srv, ws };
}

const helper = (name: string, args: string[]): string => {
  switch (name) {
    case "mids":
      return futuresChannel.mids();
    case "orderbook":
      return futuresChannel.orderbook(args[0]!);
    case "trades":
      return futuresChannel.trades(args[0]!);
    case "candles":
      return futuresChannel.candles(args[0]!, args[1] as FuturesInterval);
    case "status":
      return futuresChannel.status();
    case "account":
      return futuresChannel.account();
    default:
      throw new Error(`no helper ${name}`);
  }
};

describe("conformance/ws/futures.json: channel names", () => {
  it.each(F.channel_names.valid.map((v) => [v[2], v] as const))("%s", (_n, [name, args, expected]) => {
    expect(helper(name, args)).toBe(expected);
  });

  it.each(F.channel_names.invalid.map((v) => [`${v[0]}(${v[1].map((a) => JSON.stringify(a)).join(", ")})`, v] as const))(
    "%s is a local CONFIG error, nothing sent",
    async (_n, [name, args]) => {
      expect(() => helper(name, args)).toThrow(expect.objectContaining({ code: "CONFIG" }));
      // The same names given to subscribe() are refused locally too.
      const { srv, ws } = await connect();
      const raw = name === "candles" ? `futures.candles:${args[0]}:${args[1]}` : `futures.${name}:${args[0]}`;
      await expect(ws.subscribe([raw])).rejects.toMatchObject({ code: "CONFIG" });
      await ws.ping();
      expect(srv.conns[0]!.received.filter((m) => m.op === "subscribe")).toEqual([]);
    },
  );
});

describe("conformance/ws/futures.json: frames", () => {
  it.each(F.frames.map((f) => [f.id, f] as const))("%s is delivered as a typed event", async (_id, c) => {
    const { srv, ws } = await connect();
    const got: WsEvent[] = [];
    ws.on("event", (e) => got.push(e));
    srv.conns[0]!.send(c.frame);
    await srv.until(() => got.length === 1, "event");
    const e: { type: string; channel: string; sequence?: number; data: any } = got[0]!;
    expect(e.type).toBe(c.expect["event_type"]);
    expect(e.channel).toBe(c.expect["channel"]);
    if ("sequence" in c.expect) expect(e.sequence).toBe(c.expect["sequence"]);
    if ("best_bid" in c.expect) {
      expect([e.data.bids[0].price, e.data.bids[0].size]).toEqual(c.expect["best_bid"]);
      expect([e.data.asks[0].price, e.data.asks[0].size]).toEqual(c.expect["best_ask"]);
    }
    if ("trade_count" in c.expect) expect(e.data.trades).toHaveLength(c.expect["trade_count"] as number);
    if ("open_time" in c.expect) expect(e.data.candle.open_time).toBe(c.expect["open_time"]);
    if ("state" in c.expect) expect(e.data.state).toBe(c.expect["state"]);
    if ("position_count" in c.expect) expect(e.data.positions.positions).toHaveLength(c.expect["position_count"] as number);
    if ("stale" in c.expect) expect(e.data.stale).toBe(c.expect["stale"]);
    if ("order_count" in c.expect) expect(e.data.orders).toHaveLength(c.expect["order_count"] as number);
    expect(e.data).toEqual(c.frame["data"]);
  });
});

describe("conformance/ws/futures.json: scenarios", () => {
  it.each(F.scenarios.map((s) => [s.id, s] as const))("%s", async (_id, sc) => {
    const { srv, ws } = await connect();
    const conn = srv.conns[0]!;
    const events: string[] = [];
    const resyncChannels: string[] = [];
    const serverErrors: string[] = [];
    const errorEvents: string[] = [];
    ws.on("event", (e) => events.push(e.type));
    ws.on("resync", (reason, channel) => {
      if (reason === "futures_resync" && channel !== undefined) resyncChannels.push(channel);
    });
    ws.on("serverError", (e) => serverErrors.push(e.code));
    ws.on("error", (e) => errorEvents.push((e as CexyWebSocketError).code));

    const sent = () => conn.received.filter((m) => m.op !== "ping");
    let consumed = 0;
    /** The SDK's next request of one of `ops` not answered yet (waits for it). */
    const take = async (ops: string[]) => {
      const idx = () => sent().findIndex((m, j) => j >= consumed && ops.includes(m.op));
      await srv.until(() => idx() >= 0, `client ${ops.join("/")}`);
      const i = idx();
      consumed = i + 1;
      return sent()[i];
    };
    const calls: Promise<unknown>[] = [];

    for (const step of sc.steps) {
      if (step.client === "subscribe") calls.push(ws.subscribe(step.channels!).catch((e: unknown) => e));
      else if (step.client === "auth_key") calls.push(ws.authKey().catch((e: unknown) => e));
      else if (step.server) {
        const frame = { ...step.server };
        if (frame["type"] === "authenticated") frame["id"] = (await take(["auth_key", "auth"])).id;
        if (frame["type"] === "subscribed") frame["id"] = (await take(["subscribe"])).id;
        conn.send(frame);
        if (frame["type"] === "authenticated") await srv.until(() => ws.userId !== null, "authenticated");
      } else if (step.server_reply_to) {
        const req = await take([step.server_reply_to]);
        conn.send({ ...step.frame, id: req.id });
      }
      await ticks(20);
    }
    const want = sc.expect.client_sends_after;
    if (want?.length) await srv.until(() => sent().length >= consumed + want.length, "client sends");
    await ws.ping(); // a round trip: everything the client reacted to has been sent
    await ticks(20);
    await Promise.race([Promise.all(calls), ticks(1)]);

    if (sc.expect.events) expect(events).toEqual(sc.expect.events);
    if (sc.expect.resync_channels) expect(resyncChannels).toEqual(sc.expect.resync_channels);
    if (want) expect(sent().slice(consumed).map((m) => ({ op: m.op, channels: m.channels }))).toEqual(want);
    expect(serverErrors).toEqual(sc.expect.errors ?? []);
    // A refusal of the automatic re-subscribe is reported as an `error` too.
    for (const code of sc.expect.errors ?? []) if (sc.id.startsWith("account_")) expect(errorEvents).toContain(code);
    if (sc.expect.held_channels_after) {
      expect(ws.channels).toEqual(sc.expect.held_channels_after);
      expect(ws.pendingPrivateChannels).toEqual([]);
    }
    if (sc.expect.held_pending_private) expect(ws.pendingPrivateChannels).toEqual(sc.expect.held_pending_private);
  });
});

describe("futures WebSocket behaviour", () => {
  it(`pings at least every ${F.ping_interval_max_seconds} s`, () => {
    expect(MAX_PING_INTERVAL_MS).toBe(F.ping_interval_max_seconds * 1000);
    expect(DEFAULT_PING_INTERVAL_MS).toBeLessThanOrEqual(MAX_PING_INTERVAL_MS);
    expect(() => new CexyWebSocket({ pingIntervalMs: MAX_PING_INTERVAL_MS + 1 })).toThrow(expect.objectContaining({ code: "CONFIG" }));
  });

  it("each futures channel goes in a request of its own: a partial refusal resolves and names its channel", async () => {
    const { srv, ws } = await connect();
    const conn = srv.conns[0]!;
    const p = ws.subscribe(["ticker:BTC/USDT", "futures.orderbook:BTC", "futures.orderbook:btc"]).catch((e: unknown) => e);
    await srv.until(() => conn.received.filter((m) => m.op === "subscribe").length === 3, "three subscribes");
    const subs = conn.received.filter((m) => m.op === "subscribe");
    expect(subs.map((m) => m.channels)).toEqual([["ticker:BTC/USDT"], ["futures.orderbook:BTC"], ["futures.orderbook:btc"]]);
    conn.send({ type: "subscribed", channels: ["ticker:BTC/USDT"], id: subs[0].id });
    conn.send({ type: "subscribed", channels: ["futures.orderbook:BTC"], id: subs[1].id });
    conn.send({ type: "error", code: "NOT_FOUND", message: "Futures market not found", id: subs[2].id }); // no ack follows
    const res = (await p) as SubscribeResult;
    expect(res.added.sort()).toEqual(["futures.orderbook:BTC", "ticker:BTC/USDT"]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]!.channel).toBe("futures.orderbook:btc");
    expect(res.rejected[0]!.error).toBeInstanceOf(CexyWebSocketError);
    expect(res.rejected[0]!.error).toMatchObject({ code: "NOT_FOUND", fromServer: true, channels: ["futures.orderbook:btc"] });
    expect(ws.channels.sort()).toEqual(["futures.orderbook:BTC", "ticker:BTC/USDT"]);
    await ws.ping();
    expect(conn.received.filter((m) => m.op === "subscribe")).toHaveLength(3); // not retried
  });

  it("futures.account subscribed before auth is sent once authKey() succeeds; public futures resync is not resubscribed", async () => {
    const { srv, ws } = await connect();
    const conn = srv.conns[0]!;
    const res = await ws.subscribe([futuresChannel.account()]);
    expect(res.added).toEqual([]);
    expect(ws.pendingPrivateChannels).toEqual(["futures.account"]);
    const auth = ws.authKey();
    await srv.until(() => conn.received.some((m) => m.op === "auth_key"), "auth_key");
    conn.send({ type: "authenticated", user_id: "u1", auth: "api_key", challenge: "c-2", id: conn.received.find((m) => m.op === "auth_key").id });
    await auth;
    await srv.until(() => conn.received.some((m) => m.op === "subscribe"), "held subscribe sent");
    expect(conn.received.find((m) => m.op === "subscribe").channels).toEqual(["futures.account"]);
    expect(ws.channels).toEqual(["futures.account"]);
    expect(ws.pendingPrivateChannels).toEqual([]);
  });
});
