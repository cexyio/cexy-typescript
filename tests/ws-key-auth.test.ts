/** WebSocket API-key authentication (planned): challenge handling, re-auth, no loops. */
import { afterEach, describe, expect, it } from "vitest";
import { CexyWebSocket, type AuthChange } from "../src/index.js";
import { HmacAuthenticator } from "../src/signing.js";
import { loadJson } from "./helpers.js";
import { startFakeServer } from "./ws-server.js";

const V = loadJson<{ key_id: string; secret: string; ws: { welcome: { connection_id: string; challenge: string }; auth_key: { signature: string } } }>(
  "conformance/signing/vectors.json",
);
type Server = Awaited<ReturnType<typeof startFakeServer>>;
let srv: Server | null = null;
let ws: CexyWebSocket | null = null;
afterEach(async () => {
  ws?.close();
  ws = null;
  await srv?.close();
  srv = null;
});

const signer = new HmacAuthenticator(V.key_id, V.secret);
const reqs = (i = 0) => srv!.conns[i]!.received.filter((m) => m.op === "auth_key");

describe("authKey()", () => {
  it("signs the welcome challenge (vector), exposes auth, and takes the next challenge from the reply", async () => {
    srv = await startFakeServer({ auth: "silent", welcome: { connection_id: V.ws.welcome.connection_id, challenge: V.ws.welcome.challenge } });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, keySigner: signer });
    await ws.connect();
    const p = ws.authKey();
    await srv.until(() => reqs().length === 1, "auth_key");
    const r1 = reqs()[0];
    expect(r1).toMatchObject({ op: "auth_key", key_id: V.key_id, signature: V.ws.auth_key.signature });
    expect(Object.keys(r1)).not.toContain("secret");
    srv.conns[0]!.send({ type: "authenticated", user_id: "aaaa0001", auth: "api_key", challenge: "next-1", id: r1.id });
    expect(await p).toEqual({ userId: "aaaa0001", queued: false, auth: "api_key" });
    // A second authKey() signs the NEW challenge, never the first one again.
    const p2 = ws.authKey();
    await srv.until(() => reqs().length === 2, "second auth_key");
    const expected = await signer.signWebSocketChallenge(V.ws.welcome.connection_id, "next-1");
    expect(reqs()[1]!.signature).toBe(expected.signature);
    srv.conns[0]!.send({ type: "authenticated", user_id: "aaaa0001", auth: "api_key", challenge: "next-2", id: reqs()[1]!.id });
    await p2;
  });

  it("a refused auth_key signs out, keeps the new challenge, and is not retried automatically", async () => {
    srv = await startFakeServer({ auth: "silent", welcome: { challenge: "c-1" } });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: { baseDelayMs: 1, maxDelayMs: 2 }, keySigner: signer });
    const changes: AuthChange[] = [];
    ws.on("authChanged", (c) => changes.push(c));
    ws.on("error", () => {});
    await ws.connect();
    const p = ws.authKey();
    await srv.until(() => reqs().length === 1, "auth_key");
    srv.conns[0]!.send({ type: "error", code: "UNAUTHENTICATED", message: "bad key", challenge: "c-2", id: reqs()[0]!.id });
    await expect(p).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    srv.conns[0]!.socket.terminate();
    await srv.until(() => srv!.conns.length === 2 && ws!.connected, "reconnect");
    await ws.ping();
    expect(reqs(1)).toHaveLength(0); // no automatic retry of a refused key
  });

  it("after a reconnect it signs the NEW welcome challenge; a reply lost with the old socket is never reused", async () => {
    srv = await startFakeServer({ auth: "silent", welcome: (n) => ({ challenge: n === 0 ? "first" : "second" }) });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: { baseDelayMs: 1, maxDelayMs: 2 }, keySigner: signer });
    ws.on("error", () => {});
    await ws.connect();
    const cid = ws.welcome!.connection_id;
    void ws.authKey().catch(() => {});
    await srv.until(() => reqs().length === 1, "auth_key");
    expect(reqs(0)[0]!.signature).toBe((await signer.signWebSocketChallenge(cid, "first")).signature);
    srv.conns[0]!.socket.terminate(); // the reply to this auth_key never arrives
    await srv.until(() => srv!.conns.length === 2 && reqs(1).length === 1, "re-auth on the new connection");
    expect(reqs(1)[0]!.signature).toBe((await signer.signWebSocketChallenge(cid, "second")).signature);
    srv.conns[1]!.send({ type: "authenticated", user_id: "aaaa0001", auth: "api_key", challenge: "n2", id: reqs(1)[0]!.id });
    await ws.ping();
    expect(reqs(1)).toHaveLength(1);
  });

  it("key_revoked / key_expired sign out and stop automatic key re-auth", async () => {
    srv = await startFakeServer({ auth: "silent", welcome: { challenge: "c" } });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, keySigner: signer });
    const changes: AuthChange[] = [];
    ws.on("authChanged", (c) => changes.push(c));
    await ws.connect();
    const p = ws.authKey();
    await srv.until(() => reqs().length === 1, "auth_key");
    srv.conns[0]!.send({ type: "authenticated", user_id: "aaaa0001", auth: "api_key", challenge: "c2", id: reqs()[0]!.id });
    await p;
    srv.conns[0]!.send({ type: "signed_out", reason: "key_revoked" });
    await ws.ping();
    expect(changes.at(-1)).toMatchObject({ reason: "key_revoked", previousUserId: "aaaa0001" });
  });

  it("a challenge is consumed when signed: a second authKey() without a new challenge sends nothing", async () => {
    srv = await startFakeServer({ auth: "silent", welcome: { challenge: "only" } });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: false, keySigner: signer, ackTimeoutMs: 50 });
    await ws.connect();
    await expect(ws.authKey()).rejects.toMatchObject({ code: "TIMEOUT" }); // no reply, so no new challenge
    await expect(ws.authKey()).rejects.toMatchObject({ code: "NO_CHALLENGE" });
    expect(reqs()).toHaveLength(1);
  });

  it("a slow signer racing a reconnect: the stale signature is never sent on the new socket", async () => {
    srv = await startFakeServer({ auth: "silent", welcome: (n) => ({ challenge: n === 0 ? "first" : "second" }) });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow = {
      async signWebSocketChallenge(connectionId: string, challenge: string) {
        calls += 1;
        if (calls === 1) await gate; // only the first signature is slow (a KMS or HSM)
        return signer.signWebSocketChallenge(connectionId, challenge);
      },
    };
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: { baseDelayMs: 1, maxDelayMs: 2 }, keySigner: slow });
    ws.on("error", () => {});
    await ws.connect();
    const p = ws.authKey();
    srv.conns[0]!.socket.terminate(); // the connection changes while the signer works
    await srv.until(() => srv!.conns.length === 2 && reqs(1).length === 1, "re-auth on the new connection");
    const cid = ws.welcome!.connection_id;
    expect(reqs(1)[0]!.signature).toBe((await signer.signWebSocketChallenge(cid, "second")).signature);
    release();
    await expect(p).rejects.toMatchObject({ code: "STALE_CHALLENGE" });
    srv.conns[1]!.send({ type: "authenticated", user_id: "aaaa0001", auth: "api_key", challenge: "n2", id: reqs(1)[0]!.id });
    await ws.ping();
    expect(reqs(0)).toHaveLength(0);
    expect(reqs(1)).toHaveLength(1); // the stale signature never reached the new socket
    expect(ws.userId).toBe("aaaa0001");
  });

  it("a refusal that arrives after the timeout still stops automatic key re-auth", async () => {
    srv = await startFakeServer({ auth: "silent", welcome: (n) => ({ challenge: `c-${n}` }) });
    ws = new CexyWebSocket({ url: srv.url, allowInsecure: true, reconnect: { baseDelayMs: 1, maxDelayMs: 2 }, keySigner: signer, ackTimeoutMs: 50 });
    ws.on("error", () => {});
    await ws.connect();
    await expect(ws.authKey()).rejects.toMatchObject({ code: "TIMEOUT" });
    srv.conns[0]!.send({ type: "error", code: "UNAUTHENTICATED", message: "bad key", challenge: "late", id: reqs()[0]!.id });
    await ws.ping();
    srv.conns[0]!.socket.terminate();
    await srv.until(() => srv!.conns.length === 2 && ws!.connected, "reconnect");
    await ws.ping();
    expect(reqs(1)).toHaveLength(0);
  });

  it("without a keySigner authKey() is a CONFIG error", () => {
    const w = new CexyWebSocket({ url: "ws://127.0.0.1:1/api/v1/ws", allowInsecure: true, reconnect: false });
    expect(() => w.authKey()).toThrow(/auth: "hmac"/);
  });
});
