/**
 * Read your balances with a READ-ONLY API key.
 *   CEXY_API_KEY=ak_your_key_here CEXY_API_SECRET=your_secret_here npx tsx examples/balances.ts
 *
 * Never hard-code real credentials, never put them in a URL, and never ship them in a
 * browser bundle.
 */
import { AuthenticationError, CexyClient, ForbiddenError } from "@cexyio/cexy";

const cexy = new CexyClient({
  apiKey: process.env.CEXY_API_KEY, // e.g. ak_your_key_here
  apiSecret: process.env.CEXY_API_SECRET, // e.g. your_secret_here
});

try {
  const balances = await cexy.account.balances();
  for (const b of balances) console.log(b);

  // Cursor pagination: the iterator fetches pages lazily.
  for await (const entry of cexy.account.iterateLedger({ limit: 50 }, { maxItems: 20 })) {
    console.log(entry);
  }
} catch (err) {
  if (err instanceof AuthenticationError) console.error("check CEXY_API_KEY / CEXY_API_SECRET");
  else if (err instanceof ForbiddenError) console.error(`key not allowed: ${err.code}`);
  else throw err;
}
