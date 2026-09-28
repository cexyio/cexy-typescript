import type { KnownLedgerReference, LedgerReference, LedgerReferenceType } from "./types.js";

const KNOWN_LEDGER_REFERENCE_TYPES: ReadonlySet<string> = new Set<LedgerReferenceType>([
  "deposit", "withdrawal", "order", "trade", "transfer", "adjustment", "pool", "futures_transfer", "system",
]);

/**
 * Narrows a ledger entry's `reference`:
 * - `isLedgerReference(ref)`: true for any documented variant;
 * - `isLedgerReference(ref, "trade")`: true only for that variant, typed accordingly.
 * Unknown (newer) types return false and keep their raw fields.
 */
export function isLedgerReference(ref: LedgerReference): ref is KnownLedgerReference;
export function isLedgerReference<T extends LedgerReferenceType>(
  ref: LedgerReference,
  type: T,
): ref is Extract<KnownLedgerReference, { type: T }>;
export function isLedgerReference(ref: LedgerReference, type?: LedgerReferenceType): boolean {
  if (typeof ref !== "object" || ref === null || typeof ref.type !== "string") return false;
  return type === undefined ? KNOWN_LEDGER_REFERENCE_TYPES.has(ref.type) : ref.type === type;
}
