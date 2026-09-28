// Consumer smoke test (CommonJS): the require() entry of the installed tarball.
// Usage: node smoke.cjs <expected-version>. A live public time() call runs only with CEXY_LIVE_TESTS=1.
const cexy = require("@cexyio/cexy");

const expected = process.argv[2];
if (cexy.VERSION !== expected) throw new Error(`CJS VERSION ${cexy.VERSION} != package.json ${expected}`);
for (const name of ["CexyClient", "CexyApiError", "CancelAllInterruptedError", "MAX_SERVER_WAIT_MS"]) {
  if (cexy[name] === undefined) throw new Error(`CJS export ${name} is missing`);
}
const client = new cexy.CexyClient();
(async () => {
  if (process.env.CEXY_LIVE_TESTS === "1") {
    const t = await client.time();
    console.log(`CJS live time() ok: ${t.iso}`);
  }
  console.log(`CJS consumer smoke ok (${cexy.VERSION})`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
