// Consumer smoke test (ESM): runs in an empty project that installed the packed tarball, so no
// dev dependency of this repo can mask a missing runtime dependency or a broken export map.
// Usage: node smoke.mjs <expected-version>. A live public time() call runs only with CEXY_LIVE_TESTS=1.
import { CancelAllInterruptedError, CexyApiError, CexyClient, MAX_SERVER_WAIT_MS, VERSION } from "@cexyio/cexy";

const expected = process.argv[2];
if (VERSION !== expected) throw new Error(`ESM VERSION ${VERSION} != package.json ${expected}`);
for (const [name, value] of Object.entries({ CexyClient, CexyApiError, CancelAllInterruptedError, MAX_SERVER_WAIT_MS })) {
  if (value === undefined) throw new Error(`ESM export ${name} is missing`);
}
const client = new CexyClient();
if (typeof client.time !== "function" || typeof client.trading.cancelAll !== "function") {
  throw new Error("ESM client is missing methods");
}
if (process.env.CEXY_LIVE_TESTS === "1") {
  const t = await client.time();
  console.log(`ESM live time() ok: ${t.iso}`);
}
console.log(`ESM consumer smoke ok (${VERSION})`);
