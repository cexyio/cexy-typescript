// Consumer smoke test (ESM): runs in an empty project that installed the packed tarball, so no
// dev dependency of this repo can mask a missing runtime dependency or a broken export map.
// Usage: node smoke.mjs <expected-version>. A live public time() call runs only with CEXY_LIVE_TESTS=1.
import {
  CancelAllInterruptedError,
  CexyApiError,
  CexyClient,
  HmacAuthenticator,
  MAX_CLOCK_OFFSET_MS,
  MAX_SERVER_WAIT_MS,
  PagingStalledError,
  SIGNING_SCHEME,
  VERSION,
} from "@cexyio/cexy";

const expected = process.argv[2];
if (VERSION !== expected) throw new Error(`ESM VERSION ${VERSION} != package.json ${expected}`);
for (const [name, value] of Object.entries({ CexyClient, CexyApiError, CancelAllInterruptedError, MAX_SERVER_WAIT_MS, HmacAuthenticator, SIGNING_SCHEME, MAX_CLOCK_OFFSET_MS, PagingStalledError })) {
  if (value === undefined) throw new Error(`ESM export ${name} is missing`);
}
const client = new CexyClient();
// Request signing from the public entry point: the spec's WS auth_key vector (fixed test constants).
const signed = await new HmacAuthenticator("ak_vector0000000", "vKq3Yb7lW0cN2sR9tUe5xZa1dFh4jMp6oQi8gHs0Ly2").signWebSocketChallenge("c0nnection01", "q0R3kX7mV9pT2wZ5nB8cD1fG4hJ6lN0sU3yA5eI7oK0");
if (signed.signature !== "98a60217d4bc2c688e951d776d80cddbf0de16a7da082019884cc4b4d3199e7a") throw new Error("ESM HmacAuthenticator signature mismatch");
if (SIGNING_SCHEME !== "CEXY-HMAC-SHA256-v1") throw new Error("ESM SIGNING_SCHEME mismatch");
if (typeof client.time !== "function" || typeof client.trading.cancelAll !== "function" || typeof client.trading.cancelAllAfter !== "function" || typeof client.futures?.iterateFills !== "function") {
  throw new Error("ESM client is missing methods");
}
if (process.env.CEXY_LIVE_TESTS === "1") {
  const t = await client.time();
  console.log(`ESM live time() ok: ${t.iso}`);
}
console.log(`ESM consumer smoke ok (${VERSION})`);
