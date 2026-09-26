import { InvalidAmountError } from "./errors.js";

/**
 * An exact decimal amount as a string, e.g. `"0.00150000"`. The API never uses JSON numbers
 * for money. Do arithmetic with a decimal library (decimal.js, big.js, ...), never with `number`.
 */
export type Amount = string;

const AMOUNT_RE = /^-?\d+(\.\d+)?$/;

/** True if `value` is a well-formed decimal string (`"1"`, `"0.5"`, `"-2.25"`). */
export function isAmount(value: unknown): value is Amount {
  return typeof value === "string" && AMOUNT_RE.test(value);
}

/**
 * Throws `InvalidAmountError` if an amount field holds a number, bigint or malformed string.
 * `null`/`undefined` are allowed (optional fields). Called before any request is sent.
 */
export function assertAmountFields(body: Record<string, unknown>, fields: readonly string[], context: string): void {
  for (const field of fields) {
    const v = body[field];
    if (v === undefined || v === null) continue;
    if (typeof v === "number" || typeof v === "bigint") {
      throw new InvalidAmountError(
        field,
        `${context}: ${field} must be a decimal string such as "0.5", not a ${typeof v}. ` +
          `JS numbers are binary floats and cannot represent most decimals exactly.`,
      );
    }
    if (!isAmount(v)) {
      throw new InvalidAmountError(field, `${context}: ${field} must be a plain decimal string (digits, optional "." and sign)`);
    }
  }
}
