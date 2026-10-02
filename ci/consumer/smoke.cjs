// Consumer smoke test (CommonJS): the require() entry of the installed tarball.
// Usage: node smoke.cjs <expected-version>. A live public time() call runs only with CEXY_LIVE_TESTS=1.
const cexy = require("@cexyio/cexy");

const expected = process.argv[2];
if (cexy.VERSION !== expected) throw new Error(`CJS VERSION ${cexy.VERSION} != package.json ${expected}`);
for (const name of ["CexyClient", "CexyApiError", "CancelAllInterruptedError", "MAX_SERVER_WAIT_MS", "HmacAuthenticator", "SIGNING_SCHEME", "MAX_CLOCK_OFFSET_MS", "PagingStalledError"]) {
  if (cexy[name] === undefined) throw new Error(`CJS export ${name} is missing`);
}
const client = new cexy.CexyClient();
if (typeof client.futures?.iterateFunding !== "function") throw new Error("CJS client is missing futures methods");
(async () => {
  // Request signing from the public entry point: the spec's WS auth_key vector (fixed test constants).
  const signed = await new cexy.HmacAuthenticator("ak_vector0000000", "vKq3Yb7lW0cN2sR9tUe5xZa1dFh4jMp6oQi8gHs0Ly2").signWebSocketChallenge("c0nnection01", "q0R3kX7mV9pT2wZ5nB8cD1fG4hJ6lN0sU3yA5eI7oK0");
  if (signed.signature !== "98a60217d4bc2c688e951d776d80cddbf0de16a7da082019884cc4b4d3199e7a") throw new Error("CJS HmacAuthenticator signature mismatch");
  if (process.env.CEXY_LIVE_TESTS === "1") {
    const t = await client.time();
    console.log(`CJS live time() ok: ${t.iso}`);
  }
  console.log(`CJS consumer smoke ok (${cexy.VERSION})`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
