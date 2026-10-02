import { FUTURES_INTERVALS } from "./types.js";

/** A futures coin as the server accepts it: ASCII letters and digits, 1-20 characters, case kept. */
const COIN = /^[A-Za-z0-9]{1,20}$/;
const INTERVALS: ReadonlySet<string> = new Set(FUTURES_INTERVALS);

/** True for a channel of the futures family (`futures.*`). */
export function isFuturesChannel(channel: string): boolean {
  return channel.startsWith("futures.");
}

/** Problem with a coin, or null when it is valid. */
export function futuresCoinProblem(coin: unknown): string | null {
  if (typeof coin !== "string" || !COIN.test(coin)) {
    return `futures coin must be 1-20 ASCII letters or digits, sent as given (case-sensitive): ${JSON.stringify(coin)}`;
  }
  return null;
}

/** Problem with an interval, or null when it is valid. */
export function futuresIntervalProblem(interval: unknown): string | null {
  if (typeof interval !== "string" || !INTERVALS.has(interval)) {
    return `futures candle interval must be one of ${FUTURES_INTERVALS.join(", ")}: ${JSON.stringify(interval)}`;
  }
  return null;
}

/**
 * Checks a known futures channel name locally (nothing is sent for an invalid one). Returns a
 * problem, or null. Unknown `futures.*` kinds pass (the server may add channels).
 */
export function futuresChannelProblem(channel: string): string | null {
  const [kind, ...args] = channel.split(":");
  switch (kind) {
    case "futures.mids":
    case "futures.status":
    case "futures.account":
      return args.length === 0 ? null : `${kind} takes no coin: ${JSON.stringify(channel)}`;
    case "futures.orderbook":
    case "futures.trades":
      return args.length === 1 ? futuresCoinProblem(args[0]) : `${kind} needs exactly one coin, e.g. ${kind}:BTC`;
    case "futures.candles":
      if (args.length !== 2) return "futures.candles needs a coin and an interval, e.g. futures.candles:BTC:1m";
      return futuresCoinProblem(args[0]) ?? futuresIntervalProblem(args[1]);
    default:
      return null;
  }
}
