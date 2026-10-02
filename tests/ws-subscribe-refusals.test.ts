/** Subscribe refusals (every channel family) and re-subscribe refusals after reconnect / re-auth. */
import { afterEach, describe, expect, it } from "vitest";
import { CexyWebSocket, CexyWebSocketError } from "../src/index.js";
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

  it("canonical names in the ack (normalised spot symbols) are not mistaken for refusals", async () => {
    const { srv, ws } = await setup();
    const p = ws.subscribe(["ticker:btc/usdt", "ticker:X/USDT"]);
    const s = await lastSub(0, 1);
    srv.conns[0]!.send({ type: "error", code: "NOT_FOUND", message: "Market not found", id: s.id });
    srv.conns[0]!.send({ type: "subscribed", channels: ["ticker:BTC/USDT"], id: s.id });
    const r = await p;
    expect(r.rejected.map((x) => x.channel)).toEqual(["ticker:X/USDT"]);
    expect(ws.channels).toEqual(["ticker:btc/usdt"]);
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
