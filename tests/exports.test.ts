/** The signing API is reachable from the package entry point (not only from src/signing). */
import { describe, expect, it } from "vitest";
import { CexyClient, HmacAuthenticator, MAX_CLOCK_OFFSET_MS, SIGNING_SCHEME, type WsKeySigner } from "../src/index.js";

describe("public exports", () => {
  it("exports HmacAuthenticator, SIGNING_SCHEME, MAX_CLOCK_OFFSET_MS and the WsKeySigner type", async () => {
    expect(SIGNING_SCHEME).toBe("CEXY-HMAC-SHA256-v1");
    expect(MAX_CLOCK_OFFSET_MS).toBe(3_600_000);
    const auth = new HmacAuthenticator("ak_test_key", "test_secret_for_signing");
    const signer: WsKeySigner = auth;
    expect((await signer.signWebSocketChallenge("c", "x")).keyId).toBe("ak_test_key");
    // A custom authenticator plugs into the client (the documented option).
    expect(() => new CexyClient({ authenticator: auth })).not.toThrow();
  });
});
