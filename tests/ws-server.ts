/**
 * Test fixture only: a local WebSocket server on 127.0.0.1 with an OS-assigned port that
 * replays the recorded frames in cexy-api-spec/conformance/ws.
 */
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { loadJson } from "./helpers.js";

export const frames = {
  welcome: loadJson<any>("conformance/ws/welcome.json"),
  pong: loadJson<any>("conformance/ws/pong_unsolicited.json"),
  orderbookUpdate: loadJson<any>("conformance/ws/orderbook_update.json"),
  concurrentModification: loadJson<any>("conformance/ws/concurrent_modification.json"),
  sessionRevoked: loadJson<any>("conformance/ws/session_revoked.json"),
};

export interface Conn {
  socket: WebSocket;
  request: IncomingMessage;
  received: any[];
  send(frame: unknown): void;
}

export interface FakeServerOptions {
  /** Extra welcome fields (or a function of the connection index), or false for no welcome. */
  welcome?: Record<string, unknown> | false | ((n: number) => Record<string, unknown>);
  /** Reply `subscribed` to subscribe frames (default true). */
  ackSubscribe?: boolean;
  /** Reply `pong` with id to pings (default true). */
  replyPing?: boolean;
  /** How to answer `auth`: acknowledge (default), refuse with an error, or stay silent. */
  auth?: "ok" | "error" | "silent";
  /** Reply `unsubscribed` to unsubscribe frames (default true). */
  ackUnsubscribe?: boolean;
}

export async function startFakeServer(opts: FakeServerOptions = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const { port } = wss.address() as AddressInfo;
  const conns: Conn[] = [];
  const waiters: (() => void)[] = [];

  wss.on("connection", (socket, request) => {
    const conn: Conn = {
      socket,
      request,
      received: [],
      send: (f) => socket.send(typeof f === "string" ? f : JSON.stringify(f)),
    };
    conns.push(conn);
    socket.on("message", (data) => {
      const msg = JSON.parse(String(data));
      conn.received.push(msg);
      if (msg.op === "subscribe" && opts.ackSubscribe !== false) conn.send({ type: "subscribed", channels: msg.channels, id: msg.id ?? null });
      if (msg.op === "ping" && opts.replyPing !== false) conn.send({ type: "pong", id: msg.id ?? null });
      if (msg.op === "unsubscribe" && opts.ackUnsubscribe !== false) conn.send({ type: "unsubscribed", channels: msg.channels, id: msg.id ?? null });
      if (msg.op === "auth") {
        const mode = opts.auth ?? "ok";
        if (mode === "ok") conn.send({ type: "authenticated", id: msg.id ?? null, user_id: "usr_test_1" });
        if (mode === "error") conn.send({ type: "error", code: "UNAUTHENTICATED", message: "invalid token", id: msg.id ?? null });
      }
      waiters.splice(0).forEach((w) => w());
    });
    if (opts.welcome !== false) {
      const extra = typeof opts.welcome === "function" ? opts.welcome(conns.length - 1) : (opts.welcome ?? {});
      conn.send({ ...frames.welcome, ...extra });
    }
    waiters.splice(0).forEach((w) => w());
  });

  return {
    url: `ws://127.0.0.1:${port}/api/v1/ws`,
    conns,
    /** Resolves when `cond()` holds (checked on every server event and I/O turn). */
    async until(cond: () => boolean, label = "condition", limit = 20_000): Promise<void> {
      for (let i = 0; i < limit; i++) {
        if (cond()) return;
        await new Promise<void>((r) => setImmediate(r));
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };
}

/** Yields to I/O a number of times without using (possibly faked) timers. */
export async function ticks(n = 50): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
}
