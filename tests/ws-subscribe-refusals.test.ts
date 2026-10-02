/** Subscribe refusals (every channel family) and re-subscribe refusals after reconnect / re-auth. */
import { afterEach, describe, expect, it } from "vitest";
import { canonicalChannel, CexyWebSocket, CexyWebSocketError, type SubscribeResult } from "../src/index.js";
import { loadJson } from "./helpers.js";
import { frames, startFakeServer } from "./ws-server.js";

type Server = Awaited<ReturnType<typeof startFakeServer>>;
let srv: Server | null = null;
let ws: CexyWebSocket | null = null;
afterEach(async () => {
  ws?.close();
  ws = null;
  await srv?.close();
  srv = null;
});

const subs = (conn: number) => srv!.conns[conn]!.received.filter((m) => m.op === "subscribe");
const lastSub = async (conn: number, n: number) => {
  await srv!.until(() => subs(conn).length >= n, `subscribe #${n}`);
  return subs(conn)[n - 1];
};

async function setup(ackTimeoutMs = 5_000) {
  srv = await startFakeServer({ ackSubscribe: false, auth: "silent" });
  ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: { baseDelayMs: 1, maxDelayMs: 2 }, ackTimeoutMs });
  const errors: string[] = [];
  ws.on("error", (e) => errors.push((e as CexyWebSocketError).code));
  await ws.connect();
  return { srv, ws, errors };
}

async function authOk(conn: number, token: string) {
  const p = ws!.auth(token);
  await srv!.until(() => srv!.conns[conn]!.received.some((m) => m.op === "auth" && m.token === token), "auth");
  const req = srv!.conns[conn]!.received.filter((m) => m.op === "auth" && m.token === token).at(-1);
  srv!.conns[conn]!.send({ type: "authenticated", user_id: "usr_test_1", id: req.id });
  await p;
}

describe("subscribe(): refusals are collected per request", () => {
  it("a partly refused spot batch (one frame): the accepted channels are held and the call resolves", async () => {
    const { srv, ws } = await setup();
    const p = ws.subscribe(["ticker:A/USDT", "ticker:B/USDT", "ticker:C/USDT"]);
    const s = await lastSub(0, 1);
    expect(s.channels).toEqual(["ticker:A/USDT", "ticker:B/USDT", "ticker:C/USDT"]); // spot stays one frame
    srv.conns[0]!.send({ type: "error", code: "NOT_FOUND", message: "Market not found", id: s.id }); // errors before the ack
    srv.conns[0]!.send({ type: "subscribed", channels: ["ticker:A/USDT", "ticker:C/USDT"], id: s.id });
    const r = await p;
    expect(r.added).toEqual(["ticker:A/USDT", "ticker:C/USDT"]);
    expect(r.rejected.map((x) => [x.channel, x.error.code])).toEqual([["ticker:B/USDT", "NOT_FOUND"]]);
    expect(r.rejected[0]!.error.channels).toEqual(["ticker:B/USDT"]);
    expect(ws.channels.sort()).toEqual(["ticker:A/USDT", "ticker:C/USDT"]);
    await ws.ping();
    expect(subs(0)).toHaveLength(1); // not retried
  });

  it("canonical names in the ack (btc_usdt -> BTC/USDT) are not mistaken for refusals", async () => {
    const { srv, ws } = await setup();
    const p = ws.subscribe(["ticker:btc_usdt", "ticker:X/USDT"]);
    const s = await lastSub(0, 1);
    srv.conns[0]!.send({ type: "error", code: "NOT_FOUND", message: "Market not found", id: s.id });
    srv.conns[0]!.send({ type: "subscribed", channels: ["ticker:BTC/USDT"], id: s.id });
    const r = await p;
    expect(r.rejected.map((x) => x.channel)).toEqual(["ticker:X/USDT"]);
    expect(ws.channels).toEqual(["ticker:BTC/USDT"]); // held under the ack's canonical name
  });

  it("an accepted channel is held, re-sent and unsubscribed under the ack's canonical name", async () => {
    const { srv, ws } = await setup();
    const p = ws.subscribe(["ticker:eth_usdt"]);
    const s0 = await lastSub(0, 1);
    srv.conns[0]!.send({ type: "subscribed", channels: ["ticker:ETH/USDT"], id: s0.id });
    expect((await p).added).toEqual(["ticker:ETH/USDT"]);
    expect(ws.channels).toEqual(["ticker:ETH/USDT"]);
    srv.conns[0]!.socket.terminate();
    await srv.until(() => srv.conns.length === 2, "reconnect");
    const s1 = await lastSub(1, 1);
    expect(s1.channels).toEqual(["ticker:ETH/USDT"]);
    srv.conns[1]!.send({ type: "subscribed", channels: ["ticker:ETH/USDT"], id: s1.id });
    const u = ws.unsubscribe(["ticker:eth_usdt"]); // any spelling finds the held name
    await srv.until(() => srv.conns[1]!.received.some((m) => m.op === "unsubscribe"), "unsubscribe");
    const un = srv.conns[1]!.received.find((m) => m.op === "unsubscribe");
    expect(un.channels).toEqual(["ticker:ETH/USDT"]);
    srv.conns[1]!.send({ type: "unsubscribed", channels: ["ticker:ETH/USDT"], id: un.id });
    await u;
    expect(ws.channels).toEqual([]);
  });

  it("channel kinds match exactly: Ticker:BTC/USDT is not a spelling of ticker:BTC/USDT", async () => {
    expect(canonicalChannel(" Ticker:btc_usdt ")).toBe("Ticker:BTC/USDT");
    expect(canonicalChannel("ticker:btc_usdt")).toBe("ticker:BTC/USDT");
    expect(canonicalChannel("Orders")).toBe("Orders");
    expect(canonicalChannel("futures.orderbook:btc")).toBe("futures.orderbook:btc");
    const { srv, ws } = await setup();
    const p = ws.subscribe(["Ticker:BTC/USDT", "ticker:BTC/USDT"]);
    const s = await lastSub(0, 1);
    expect(s.channels).toEqual(["Ticker:BTC/USDT", "ticker:BTC/USDT"]); // two channels: both sent
    srv.conns[0]!.send({ type: "error", code: "VALIDATION_FAILED", message: "(any text)", id: s.id });
    srv.conns[0]!.send({ type: "subscribed", channels: ["ticker:BTC/USDT"], id: s.id });
    const r = await p;
    expect(r.rejected.map((x) => [x.channel, x.error.code])).toEqual([["Ticker:BTC/USDT", "VALIDATION_FAILED"]]);
    expect(ws.channels).toEqual(["ticker:BTC/USDT"]);
  });

  it("a channel already held under another spelling is not sent again", async () => {
    const { srv, ws } = await setup();
    const p = ws.subscribe(["ticker:btc_usdt"]);
    const s = await lastSub(0, 1);
    srv.conns[0]!.send({ type: "subscribed", channels: ["ticker:BTC/USDT"], id: s.id });
    await p;
    const r = await ws.subscribe(["ticker:BTC/USDT"]);
    expect(r.alreadySubscribed).toEqual(["ticker:BTC/USDT"]);
    expect(subs(0)).toHaveLength(1);
  });

  it("every channel refused: completes on the last error (no ack follows) and rejects; nothing held", async () => {
    const { srv, ws } = await setup(60_000);
    const p = ws.subscribe(["ticker:A/USDT", "orders"]);
    const s = await lastSub(0, 1);
    srv.conns[0]!.send({ type: "error", code: "NOT_FOUND", message: "Market not found", id: s.id });
    srv.conns[0]!.send({ type: "error", code: "UNAUTHENTICATED", message: "authentication required", id: s.id });
    await expect(p).rejects.toMatchObject({ code: "NOT_FOUND", fromServer: true, channels: ["ticker:A/USDT", "orders"] });
    expect(ws.channels).toEqual([]);
  });

  it("ack timeout after at least one error: every channel counts as refused", async () => {
    const { srv, ws } = await setup(80);
    const p = ws.subscribe(["ticker:A/USDT", "ticker:B/USDT"]);
    const s = await lastSub(0, 1);
    srv.conns[0]!.send({ type: "error", code: "RATE_LIMITED", message: "This connection may hold at most 100 subscriptions.", id: s.id });
    await expect(p).rejects.toMatchObject({ code: "RATE_LIMITED", channels: ["ticker:A/USDT", "ticker:B/USDT"] });
    expect(ws.channels).toEqual([]);
  });

  it("ack timeout without any error rejects TIMEOUT", async () => {
    const { ws } = await setup(80);
    await expect(ws.subscribe(["ticker:A/USDT"])).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("re-subscribe refusals", () => {
  it("after a reconnect: a private channel refused UNAUTHENTICATED goes back to pending; another refusal drops and reports", async () => {
    const { srv, ws, errors } = await setup();
    await authOk(0, "tok_a");
    const p = ws.subscribe(["orders", "ticker:A/USDT", "ticker:B/USDT"]);
    const s0 = await lastSub(0, 1);
    srv.conns[0]!.send({ type: "subscribed", channels: s0.channels, id: s0.id });
    await p;
    srv.conns[0]!.socket.terminate();
    await srv.until(() => srv.conns.length === 2 && srv.conns[1]!.received.some((m) => m.op === "auth"), "re-auth");
    const auth = srv.conns[1]!.received.find((m) => m.op === "auth");
    srv.conns[1]!.send({ type: "authenticated", user_id: "usr_test_1", id: auth.id });
    const s1 = await lastSub(1, 1);
    expect(s1.channels).toEqual(["orders", "ticker:A/USDT", "ticker:B/USDT"]);
    srv.conns[1]!.send({ type: "error", code: "UNAUTHENTICATED", message: "authentication required", id: s1.id });
    srv.conns[1]!.send({ type: "error", code: "NOT_FOUND", message: "Market not found", id: s1.id });
    srv.conns[1]!.send({ type: "subscribed", channels: ["ticker:B/USDT"], id: s1.id });
    await srv.until(() => errors.length === 2, "reported");
    expect(errors).toEqual(["UNAUTHENTICATED", "NOT_FOUND"]);
    expect(ws.channels).toEqual(["ticker:B/USDT"]);
    expect(ws.pendingPrivateChannels).toEqual(["orders"]);
    // The pending private channel is sent again after the next successful auth.
    await authOk(1, "tok_b");
    const s2 = await lastSub(1, 2);
    expect(s2.channels).toEqual(["orders"]);
  });

  it("after a re-auth: a refusal other than UNAUTHENTICATED drops the channel and is reported", async () => {
    const { srv, ws, errors } = await setup();
    await authOk(0, "tok_a");
    const p = ws.subscribe(["orders", "balances"]);
    const s0 = await lastSub(0, 1);
    srv.conns[0]!.send({ type: "subscribed", channels: s0.channels, id: s0.id });
    await p;
    srv.conns[0]!.send({ ...frames.sessionRevoked, data: { ...frames.sessionRevoked.data, current: true } });
    await srv.until(() => ws.pendingPrivateChannels.length === 2, "privates pending");
    await authOk(0, "tok_b");
    const s1 = await lastSub(0, 2);
    srv.conns[0]!.send({ type: "error", code: "FORBIDDEN", message: "Private channels need a key with the read scope", id: s1.id });
    srv.conns[0]!.send({ type: "subscribed", channels: ["balances"], id: s1.id });
    await srv.until(() => errors.length === 1, "reported");
    expect(errors).toEqual(["FORBIDDEN"]);
    expect(ws.channels).toEqual(["balances"]);
    expect(ws.pendingPrivateChannels).toEqual([]);
  });
});

interface RefusalCase {
  id: string;
  send?: string[];
  concurrent?: { request: string; send: string[] }[];
  server: any[];
  expect: any;
}
const R = loadJson<{ cases: RefusalCase[] }>("conformance/ws/subscribe_refusals.json");

/** What a subscribe() call produced, in the conformance file's terms. */
async function outcome(p: Promise<SubscribeResult>) {
  try {
    const r = await p;
    return { added: r.added, refused: Object.fromEntries(r.rejected.map((x) => [x.channel, x.error.code])), fails: false, error: null };
  } catch (e) {
    const err = e as CexyWebSocketError;
    return { added: [], refused: Object.fromEntries(err.rejected.map((x) => [x.channel, x.error.code])), fails: true, error: err };
  }
}

describe("conformance/ws/subscribe_refusals.json", () => {
  it("has the cases this suite knows how to run", () => {
    expect(R.cases.map((c) => c.id)).toEqual([
      "partly_refused_spot_batch",
      "spot_canonicalised_in_ack",
      "futures_coin_case_sensitive",
      "all_refused_no_ack",
      "limit_stop_last_error_covers_rest",
      "error_for_other_request_not_misattributed",
      "timeout_without_answer",
      "channel_kind_is_exact",
      "same_channel_two_spellings_acked_twice",
      "event_before_ack_is_delivered",
      "idless_error_not_attributed",
    ]);
  });

  it.each(R.cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const timeoutCase = c.expect.error_code === "TIMEOUT";
    // A long ack timeout: completing before it (all refused, no ack) must not depend on it.
    const { srv, ws } = await setup(timeoutCase ? 80 : 60_000);
    const conn = srv.conns[0]!;
    const requests = c.concurrent ?? [{ request: "r", send: c.send! }];
    const events: string[] = [];
    ws.on("event", (e) => events.push(e.type));
    const calls = requests.map((r) => outcome(ws.subscribe(r.send)));
    await srv.until(() => subs(0).length === requests.length, "subscribe frames");
    // Spot and futures channels alike go in one frame per call, as given, except that spellings
    // of one channel are sent once (first spelling kept).
    const dedup = (send: string[]) => send.filter((ch, i) => send.findIndex((o) => canonicalChannel(o) === canonicalChannel(ch)) === i);
    expect(subs(0).map((m) => m.channels)).toEqual(requests.map((r) => dedup(r.send)));
    // Every subscribe carries an id.
    for (const m of subs(0)) expect(typeof m.id === "string" && m.id !== "").toBe(true);
    const idOf = Object.fromEntries(requests.map((r, i) => [r.request, subs(0)[i].id]));
    for (const step of c.server) {
      if (step.to) conn.send({ ...step.frame, id: idOf[step.to] });
      else if ("id" in step || !["error", "subscribed"].includes(step.type)) conn.send(step); // id-less error, or an event
      else conn.send({ ...step, id: idOf["r"] });
    }
    const results = await Promise.all(calls);

    if (timeoutCase) {
      expect(results[0]!.error?.code).toBe("TIMEOUT");
      expect(ws.channels).toEqual(c.expect.held_after);
      return;
    }
    const expected = c.concurrent ? requests.map((r) => c.expect[r.request]) : [c.expect];
    results.forEach((got, i) => {
      const want = expected[i];
      expect(got.fails, requests[i]!.request).toBe(want.fails);
      if (want.added) expect(got.added).toEqual(want.added);
      expect(got.refused).toEqual(want.refused);
      if (got.fails) expect(got.error?.channels).toEqual(Object.keys(want.refused));
    });
    // Refused channels are not held; accepted ones are, under the ack's canonical name.
    const refused = new Set(expected.flatMap((w) => Object.keys(w.refused)));
    const sent = requests.flatMap((r) => dedup(r.send));
    expect(ws.channels.sort()).toEqual(sent.filter((ch) => !refused.has(ch)).map(canonicalChannel).sort());
    if (c.expect.held_after) expect(ws.channels).toEqual(c.expect.held_after);
    if (c.expect.events_delivered) expect(events).toEqual(c.expect.events_delivered);
    await ws.ping();
    expect(subs(0)).toHaveLength(requests.length); // nothing retried
  });
});
