import { afterEach, describe, expect, it, vi } from "vitest";
import { CexyClient, CexyWebSocket, CexyWebSocketError, VERSION, type OrderBook, type WsEvent } from "../src/index.js";
import { frames, startFakeServer, ticks } from "./ws-server.js";

type Server = Awaited<ReturnType<typeof startFakeServer>>;
let srv: Server | null = null;
let ws: CexyWebSocket | null = null;

afterEach(async () => {
  ws?.close();
  ws = null;
  vi.useRealTimers();
  await srv?.close();
  srv = null;
});

const quietLogger = () => ({ warn: vi.fn(), debug: vi.fn() });
const levels = (n: number, start: number) => Array.from({ length: n }, (_, i) => [String(start - i), "1"] as [string, string]);
const snapshot = (sequence: number, depth = 5): OrderBook => ({
  symbol: "BTC/USDT",
  bids: levels(depth, 60000),
  asks: levels(depth, 70000).reverse(),
  sequence,
  timestamp: "2026-09-26T00:00:00Z",
});
const update = (sequence: number, bid = "61000.10") => ({
  ...frames.orderbookUpdate,
  sequence,
  data: { ...frames.orderbookUpdate.data, bids: [[bid, "0.25"]] },
});

/** A snapshot source whose responses the test resolves by hand. */
function manualRest() {
  const pending: ((b: OrderBook) => void)[] = [];
  const orderbook = vi.fn((_symbol: string, _p?: { depth?: number | null }) => new Promise<OrderBook>((r) => pending.push(r)));
  return { rest: { markets: { orderbook } }, orderbook, resolveNext: (b: OrderBook) => pending.shift()!(b) };
}

describe("connection", () => {
  it("parses the welcome frame", async () => {
    srv = await startFakeServer();
    const logger = quietLogger();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, logger });
    const welcome = await ws.connect();
    expect(welcome).toEqual(frames.welcome);
    expect(ws.welcome?.connection_id).toBe("a1b2c3d4");
    expect(ws.connected).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns once on an unknown protocol_version and continues", async () => {
    srv = await startFakeServer({ welcome: { protocol_version: 2 } });
    const logger = quietLogger();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: { baseDelayMs: 1, maxDelayMs: 2 }, logger });
    await ws.connect();
    srv.conns[0]!.socket.terminate();
    await srv.until(() => srv!.conns.length === 2 && ws!.connected, "reconnect");
    expect(logger.warn.mock.calls.filter((c) => String(c[0]).includes("protocol_version")).length).toBe(1);
  });

  it("sends the SDK User-Agent when created from CexyClient (ws package)", async () => {
    srv = await startFakeServer();
    const client = new CexyClient({ baseUrl: "https://api.cexy.io" });
    ws = client.websocket({ url: srv.url, allowInsecure: true, reconnect: false });
    await ws.connect();
    expect(srv.conns[0]!.request.headers["user-agent"]).toBe(`cexy-typescript/${VERSION}`);
    expect(srv.conns[0]!.request.headers["x-api-key"]).toBeUndefined();
    expect(client.websocket().url).toBe("wss://api.cexy.io/api/v1/ws");
  });

  it("close() stops for good", async () => {
    srv = await startFakeServer();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: { baseDelayMs: 1 } });
    await ws.connect();
    const closes: boolean[] = [];
    ws.on("close", (c) => closes.push(c.willReconnect));
    ws.close();
    await ticks(100);
    expect(closes).toEqual([false]);
    expect(srv.conns.length).toBe(1);
  });
});

describe("heartbeat", () => {
  it("pings every 30 s (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    srv = await startFakeServer();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, logger: quietLogger() });
    await ws.connect();
    const conn = srv.conns[0]!;
    const pings = () => conn.received.filter((m) => m.op === "ping").length;

    vi.advanceTimersByTime(29_999);
    await ticks();
    expect(pings()).toBe(0);
    vi.advanceTimersByTime(1);
    await srv.until(() => pings() === 1, "ping 1");
    vi.advanceTimersByTime(30_000);
    await srv.until(() => pings() === 2, "ping 2");
    vi.advanceTimersByTime(30_000);
    await srv.until(() => pings() === 3, "ping 3");
    await ticks();
    expect(conn.received.every((m) => m.op === "ping")).toBe(true);
    expect(srv.conns.length).toBe(1); // pongs keep the liveness timer happy
  });

  it("reconnects when no frame arrives for 75 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    srv = await startFakeServer({ replyPing: false });
    const logger = quietLogger();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, logger, random: () => 0 });
    await ws.connect();
    vi.advanceTimersByTime(74_999);
    await ticks();
    expect(srv.conns.length).toBe(1);
    vi.advanceTimersByTime(1);
    await ticks();
    vi.advanceTimersByTime(1); // reconnect delay (0 with this jitter)
    await srv.until(() => srv!.conns.length === 2, "reconnect");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no frame from server"));
  });

  it("accepts unsolicited pong frames (no id)", async () => {
    srv = await startFakeServer();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false });
    await ws.connect();
    const pongs: (string | null)[] = [];
    const errors: unknown[] = [];
    ws.on("pong", (id) => pongs.push(id));
    ws.on("serverError", (e) => errors.push(e));
    ws.on("error", (e) => errors.push(e));
    srv.conns[0]!.send(frames.pong);
    await srv.until(() => pongs.length === 1, "pong");
    expect(pongs).toEqual([null]);
    expect(errors).toEqual([]);
  });
});

describe("subscriptions", () => {
  it("subscribe/unsubscribe with id correlation", async () => {
    srv = await startFakeServer();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false });
    await ws.connect();
    const r = await ws.subscribe(["ticker:BTC/USDT", "trades:BTC/USDT"]);
    expect(r).toEqual({ added: ["ticker:BTC/USDT", "trades:BTC/USDT"], refused: [], alreadySubscribed: [] });
    const sub = srv.conns[0]!.received.find((m) => m.op === "subscribe");
    expect(typeof sub.id).toBe("string");
    const again = await ws.subscribe(["ticker:BTC/USDT"]);
    expect(again.alreadySubscribed).toEqual(["ticker:BTC/USDT"]);
    await ws.unsubscribe(["trades:BTC/USDT"]);
    await srv.until(() => srv!.conns[0]!.received.some((m) => m.op === "unsubscribe"), "unsubscribe");
    expect(ws.channels).toEqual(["ticker:BTC/USDT"]);
  });

  it("an error frame with the request id rejects that subscribe", async () => {
    srv = await startFakeServer({ ackSubscribe: false });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false });
    await ws.connect();
    const p = ws.subscribe(["ticker:NOPE/USDT"]);
    await srv.until(() => srv!.conns[0]!.received.some((m) => m.op === "subscribe"), "subscribe");
    const id = srv.conns[0]!.received.find((m) => m.op === "subscribe").id;
    srv.conns[0]!.send({ type: "error", code: "VALIDATION_FAILED", message: "unknown market", id });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CexyWebSocketError);
    expect((err as CexyWebSocketError).code).toBe("VALIDATION_FAILED");
  });

  it("refuses beyond 100 subscriptions locally and reports which", async () => {
    srv = await startFakeServer();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, logger: quietLogger() });
    await ws.connect();
    const chans = Array.from({ length: 101 }, (_, i) => `ticker:C${i}/USDT`);
    const r = await ws.subscribe(chans);
    expect(r.refused).toEqual(["ticker:C100/USDT"]);
    expect(srv.conns[0]!.received.find((m) => m.op === "subscribe").channels.length).toBe(100);
    expect((await ws.subscribe(["markets"])).refused).toEqual(["markets"]);
  });

  it("guards the message rate locally and validates channel names", async () => {
    srv = await startFakeServer();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, maxMessagesPerMinute: 3 });
    await ws.connect();
    await ws.subscribe(["ticker:A/USDT"]);
    await ws.subscribe(["ticker:B/USDT"]);
    await ws.subscribe(["ticker:C/USDT"]);
    await expect(ws.subscribe(["ticker:D/USDT"])).rejects.toMatchObject({ code: "LOCAL_RATE_LIMIT" });
    await expect(ws.subscribe(["x".repeat(65)])).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("ignores unknown event types and emits known ones", async () => {
    srv = await startFakeServer();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, logger: quietLogger() });
    await ws.connect();
    const events: WsEvent[] = [];
    ws.on("event", (e) => events.push(e));
    srv.conns[0]!.send({ type: "brand.new.thing", channel: "ticker", data: { x: 1 }, extra_field: true });
    srv.conns[0]!.send("not json");
    srv.conns[0]!.send({ type: "ticker.update", channel: "ticker:BTC/USDT", data: { last_price: "1" }, unknown_field: 1 });
    await srv.until(() => events.length === 1, "ticker event");
    expect(events[0]!.type).toBe("ticker.update");
  });
});

describe("order book", () => {
  it("subscribes first, snapshots, drops <= S, replays newer updates", async () => {
    srv = await startFakeServer();
    const m = manualRest();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, restClient: m.rest });
    await ws.connect();
    const bookP = ws.orderBook("BTC/USDT");
    await srv.until(() => m.orderbook.mock.calls.length === 1, "snapshot request");
    // The subscribe went out before the snapshot was requested.
    expect(srv.conns[0]!.received[0]).toMatchObject({ op: "subscribe", channels: ["orderbook:BTC/USDT"] });
    expect(m.orderbook.mock.calls[0]![1]).toEqual({ depth: 50 });
    const conn = srv.conns[0]!;
    conn.send(update(1040, "1"));
    conn.send(update(1041, "2"));
    conn.send(frames.orderbookUpdate); // sequence 1042
    await ticks(100);
    m.resolveNext(snapshot(1041));
    const book = await bookP;
    expect(book.sequence).toBe(1042);
    expect(book.bids).toEqual(frames.orderbookUpdate.data.bids);
    expect(book.asks).toEqual(frames.orderbookUpdate.data.asks);
    expect(book.stale).toBe(false);
    expect(book.synced).toBe(true);
  });

  it("keeps only the top 50 levels of a deeper REST snapshot", async () => {
    srv = await startFakeServer();
    const m = manualRest();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, restClient: m.rest });
    await ws.connect();
    const bookP = ws.orderBook("BTC/USDT");
    await srv.until(() => m.orderbook.mock.calls.length === 1, "snapshot request");
    m.resolveNext(snapshot(10, 80));
    const book = await bookP;
    expect(book.bids.length).toBe(50);
    expect(book.asks.length).toBe(50);
  });

  it("a gap marks the book stale until the next update heals it (no resync)", async () => {
    srv = await startFakeServer();
    const m = manualRest();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, restClient: m.rest });
    await ws.connect();
    const bookP = ws.orderBook("BTC/USDT");
    await srv.until(() => m.orderbook.mock.calls.length === 1, "snapshot request");
    m.resolveNext(snapshot(1042));
    const book = await bookP;
    const log: string[] = [];
    book.on("stale", (g) => log.push(`stale ${g.expected}->${g.received}`));
    book.on("healed", () => log.push("healed"));
    const conn = srv.conns[0]!;
    conn.send(update(1044, "3"));
    await srv.until(() => book.sequence === 1044, "gap update");
    expect(book.stale).toBe(true);
    expect(book.bids[0]![0]).toBe("3"); // still a full replace
    conn.send(update(1045, "4"));
    await srv.until(() => book.sequence === 1045, "healing update");
    expect(book.stale).toBe(false);
    conn.send(update(1045, "old"));
    await ticks(100);
    expect(book.bids[0]![0]).toBe("4");
    expect(log).toEqual(["stale 1043->1044", "healed"]);
    expect(m.orderbook).toHaveBeenCalledTimes(1);
  });

  it("CONCURRENT_MODIFICATION (null id) resyncs every book and emits resync", async () => {
    srv = await startFakeServer();
    const m = manualRest();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, restClient: m.rest });
    await ws.connect();
    const b1 = ws.orderBook("BTC/USDT");
    await srv.until(() => m.orderbook.mock.calls.length === 1, "snapshot 1");
    m.resolveNext(snapshot(100));
    const book1 = await b1;
    const b2 = ws.orderBook("ETH/USDT");
    await srv.until(() => m.orderbook.mock.calls.length === 2, "snapshot 2");
    m.resolveNext({ ...snapshot(200), symbol: "ETH/USDT" });
    const book2 = await b2;

    const reasons: string[] = [];
    const serverErrors: string[] = [];
    ws.on("resync", (r) => reasons.push(r));
    ws.on("serverError", (e) => serverErrors.push(e.code));
    srv.conns[0]!.send(frames.concurrentModification);
    await srv.until(() => m.orderbook.mock.calls.length === 4, "resync snapshots");
    expect(reasons).toEqual(["concurrent_modification"]);
    expect(serverErrors).toEqual(["CONCURRENT_MODIFICATION"]);
    expect(book1.synced).toBe(false);
    m.resolveNext(snapshot(150));
    m.resolveNext({ ...snapshot(260), symbol: "ETH/USDT" });
    await srv.until(() => book1.synced && book2.synced, "resynced");
    expect(book1.sequence).toBe(150);
    expect(book2.sequence).toBe(260);
  });
});

describe("reconnect", () => {
  it("reconnects with backoff, re-authenticates, re-subscribes and takes a fresh snapshot", async () => {
    srv = await startFakeServer();
    const m = manualRest();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, restClient: m.rest, reconnect: { baseDelayMs: 5, maxDelayMs: 10 }, random: () => 0.5 });
    await ws.connect();
    expect(await ws.auth("session_access_token_placeholder")).toEqual({ userId: "usr_test_1", queued: false });
    await ws.subscribe(["ticker:BTC/USDT", "orders"]);
    const bookP = ws.orderBook("BTC/USDT");
    await srv.until(() => m.orderbook.mock.calls.length === 1, "snapshot");
    m.resolveNext(snapshot(500));
    const book = await bookP;
    srv.conns[0]!.send(update(501));
    await srv.until(() => book.sequence === 501, "update 501");

    const events: string[] = [];
    ws.on("close", (c) => events.push(`close willReconnect=${c.willReconnect}`));
    ws.on("reconnecting", (r) => events.push(`reconnecting ${r.attempt} ${r.delayMs}`));
    ws.on("reconnected", () => events.push("reconnected"));
    srv.conns[0]!.socket.terminate();

    await srv.until(() => srv!.conns.length === 2 && srv!.conns[1]!.received.some((x) => x.op === "subscribe"), "resubscribe");
    const second = srv.conns[1]!.received;
    expect(second[0]).toMatchObject({ op: "auth", token: "session_access_token_placeholder" });
    const sub = second.find((x) => x.op === "subscribe");
    expect([...sub.channels].sort()).toEqual(["orderbook:BTC/USDT", "orders", "ticker:BTC/USDT"]);
    expect(events).toEqual(["close willReconnect=true", "reconnecting 1 2", "reconnected"]);

    // Fresh snapshot; sequences reset with the server, so a lower S is accepted.
    await srv.until(() => m.orderbook.mock.calls.length === 2, "fresh snapshot");
    expect(book.synced).toBe(false);
    m.resolveNext(snapshot(7));
    await srv.until(() => book.synced, "synced");
    expect(book.sequence).toBe(7);
    srv.conns[1]!.send(update(8));
    await srv.until(() => book.sequence === 8, "update 8");
    expect(book.stale).toBe(false);
  });

  it("session.revoked emits authLost, drops private channels, keeps the socket", async () => {
    srv = await startFakeServer();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: { baseDelayMs: 1, maxDelayMs: 2 } });
    await ws.connect();
    await ws.auth("session_access_token_placeholder");
    await ws.subscribe(["orders", "account", "ticker:BTC/USDT"]);
    const lost: unknown[] = [];
    ws.on("authLost", (e) => lost.push(e.data));
    srv.conns[0]!.send(frames.sessionRevoked);
    await srv.until(() => lost.length === 1, "authLost");
    expect(lost[0]).toEqual(frames.sessionRevoked.data);
    expect(ws.channels).toEqual(["ticker:BTC/USDT"]);
    expect(ws.connected).toBe(true);

    // After a reconnect the dead token is not re-sent and private channels are not restored.
    srv.conns[0]!.socket.terminate();
    await srv.until(() => srv!.conns.length === 2 && srv!.conns[1]!.received.some((x) => x.op === "subscribe"), "resubscribe");
    expect(srv.conns[1]!.received.some((x) => x.op === "auth")).toBe(false);
    expect(srv.conns[1]!.received.find((x) => x.op === "subscribe").channels).toEqual(["ticker:BTC/USDT"]);
  });
});

describe("request acknowledgements (id correlation)", () => {
  it("auth resolves on `authenticated` with the same id", async () => {
    srv = await startFakeServer();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false });
    await ws.connect();
    const users: (string | null)[] = [];
    ws.on("authenticated", (u) => users.push(u));
    const res = await ws.auth("session_access_token_placeholder");
    expect(res).toEqual({ userId: "usr_test_1", queued: false });
    const sent = srv.conns[0]!.received.find((m) => m.op === "auth");
    expect(typeof sent.id).toBe("string");
    expect(users).toEqual(["usr_test_1"]);
  });

  it("auth rejects on an error with its id and forgets the token", async () => {
    srv = await startFakeServer({ auth: "error" });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: { baseDelayMs: 1, maxDelayMs: 2 } });
    await ws.connect();
    const err = await ws.auth("expired_token_placeholder").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CexyWebSocketError);
    expect((err as CexyWebSocketError).code).toBe("UNAUTHENTICATED");
    expect((err as CexyWebSocketError).fromServer).toBe(true);
    srv.conns[0]!.socket.terminate();
    await srv.until(() => srv!.conns.length === 2 && ws!.connected, "reconnect");
    await ticks(50);
    expect(srv.conns[1]!.received.some((m) => m.op === "auth")).toBe(false);
  });

  it("auth rejects when no acknowledgement arrives in time", async () => {
    srv = await startFakeServer({ auth: "silent" });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, ackTimeoutMs: 50 });
    await ws.connect();
    await expect(ws.auth("session_access_token_placeholder")).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("auth before connecting is queued, then sent and acknowledged on connect", async () => {
    srv = await startFakeServer();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false });
    expect(await ws.auth("session_access_token_placeholder")).toEqual({ userId: null, queued: true });
    const users: (string | null)[] = [];
    ws.on("authenticated", (u) => users.push(u));
    await ws.connect();
    await srv.until(() => users.length === 1, "authenticated");
    expect(srv.conns[0]!.received[0]).toMatchObject({ op: "auth", token: "session_access_token_placeholder" });
  });

  it("concurrent subscribes are matched by id even when acknowledged out of order", async () => {
    srv = await startFakeServer({ ackSubscribe: false });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false });
    await ws.connect();
    const a = ws.subscribe(["ticker:A/USDT"]);
    const b = ws.subscribe(["ticker:B/USDT"]);
    await srv.until(() => srv!.conns[0]!.received.filter((m) => m.op === "subscribe").length === 2, "two subscribes");
    const [sa, sb] = srv.conns[0]!.received.filter((m) => m.op === "subscribe");
    expect(sa.id).not.toBe(sb.id);
    // Acknowledge B first, and with channels that would confuse channel matching.
    srv.conns[0]!.send({ type: "subscribed", channels: ["ticker:B/USDT"], id: sb.id });
    srv.conns[0]!.send({ type: "subscribed", channels: ["ticker:A/USDT"], id: sa.id });
    expect((await a).added).toEqual(["ticker:A/USDT"]);
    expect((await b).added).toEqual(["ticker:B/USDT"]);
  });

  it("an acknowledgement of the wrong type does not settle a request", async () => {
    srv = await startFakeServer({ ackSubscribe: false });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, ackTimeoutMs: 80 });
    await ws.connect();
    const p = ws.subscribe(["ticker:A/USDT"]);
    await srv.until(() => srv!.conns[0]!.received.some((m) => m.op === "subscribe"), "subscribe");
    const id = srv.conns[0]!.received.find((m) => m.op === "subscribe").id;
    srv.conns[0]!.send({ type: "unsubscribed", channels: ["ticker:A/USDT"], id });
    expect((await p).added).toEqual([]); // timed out leniently instead
  });

  it("unsubscribe resolves on `unsubscribed` with its id", async () => {
    srv = await startFakeServer();
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false });
    await ws.connect();
    await ws.subscribe(["ticker:A/USDT"]);
    const acks: string[][] = [];
    ws.on("unsubscribed", (c) => acks.push(c));
    await ws.unsubscribe(["ticker:A/USDT"]);
    expect(acks).toEqual([["ticker:A/USDT"]]);
    const sent = srv.conns[0]!.received.find((m) => m.op === "unsubscribe");
    expect(typeof sent.id).toBe("string");
  });

  it("ping() resolves on the pong with its id; unsolicited pongs do not settle it", async () => {
    srv = await startFakeServer({ replyPing: false });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false });
    await ws.connect();
    let done = false;
    const p = ws.ping().then((rtt) => {
      done = true;
      return rtt;
    });
    await srv.until(() => srv!.conns[0]!.received.some((m) => m.op === "ping"), "ping");
    srv.conns[0]!.send(frames.pong); // unsolicited, no id
    await ticks(50);
    expect(done).toBe(false);
    const id = srv.conns[0]!.received.find((m) => m.op === "ping").id;
    srv.conns[0]!.send({ type: "pong", id });
    expect(await p).toBeGreaterThanOrEqual(0);
  });
});
