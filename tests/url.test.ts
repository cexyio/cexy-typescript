import { describe, expect, it } from "vitest";
import { CexyClient, CexyConfigError, CexyWebSocket, CexyWebSocketError } from "../src/index.js";
import { mockFetch } from "./helpers.js";

const f = () => mockFetch().fetch;

describe("transport security: https:// and wss:// only", () => {
  it("rejects http:// baseUrl without allowInsecure, even for localhost", () => {
    expect(() => new CexyClient({ fetch: f(), baseUrl: "http://api.cexy.io" })).toThrow(CexyConfigError);
    expect(() => new CexyClient({ fetch: f(), baseUrl: "http://localhost" })).toThrow(/allowInsecure/);
  });

  it("allowInsecure permits http:// only for loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(() => new CexyClient({ fetch: f(), baseUrl: `http://${host}`, allowInsecure: true })).not.toThrow();
    }
    for (const host of ["api.cexy.io", "example.invalid", "localhost.example.com", "127.0.0.2"]) {
      expect(() => new CexyClient({ fetch: f(), baseUrl: `http://${host}`, allowInsecure: true }), host).toThrow(CexyConfigError);
    }
  });

  it("rejects other schemes", () => {
    expect(() => new CexyClient({ fetch: f(), baseUrl: "ftp://api.cexy.io" })).toThrow(CexyConfigError);
    expect(() => new CexyClient({ fetch: f(), baseUrl: "not a url" })).toThrow(CexyConfigError);
  });

  it("WebSocket url must be wss:// unless allowInsecure and loopback", () => {
    expect(() => new CexyWebSocket({ url: "wss://api.cexy.io/api/v1/ws" })).not.toThrow();
    expect(() => new CexyWebSocket({ url: "ws://api.cexy.io/api/v1/ws" })).toThrow(CexyWebSocketError);
    expect(() => new CexyWebSocket({ url: "ws://localhost/api/v1/ws" })).toThrow(/allowInsecure/);
    expect(() => new CexyWebSocket({ url: "ws://api.cexy.io/api/v1/ws", allowInsecure: true })).toThrow(/localhost/);
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(() => new CexyWebSocket({ url: `ws://${host}/api/v1/ws`, allowInsecure: true })).not.toThrow();
    }
    expect(() => new CexyWebSocket({ url: "https://api.cexy.io/api/v1/ws" })).toThrow(CexyWebSocketError);
  });

  it("client.websocket() derives wss:// and inherits allowInsecure", () => {
    expect(new CexyClient({ fetch: f() }).websocket().url).toBe("wss://api.cexy.io/api/v1/ws");
    const local = new CexyClient({ fetch: f(), baseUrl: "http://127.0.0.1", allowInsecure: true });
    expect(local.websocket().url).toBe("ws://127.0.0.1/api/v1/ws");
    expect(() => new CexyClient({ fetch: f() }).websocket({ url: "ws://127.0.0.1/api/v1/ws" })).toThrow(CexyWebSocketError);
  });
});
