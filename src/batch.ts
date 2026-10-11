/**
 * Batch place and batch cancel: local checks and the reading of a result after retries.
 * The HTTP calls stay in `resources.ts`. The rules are the shared conformance cases in
 * `cexy-api-spec/conformance/trading/batch_orders.json`.
 */
import { assertAmountFields } from "./amounts.js";
import { CexyApiError, CexyConfigError, CexyError, type ErrorBody } from "./errors.js";
import { attemptKind, newId, type AttemptKind } from "./http.js";
import type {
  BatchOrderItem,
  BatchOrderResponse,
  BatchOrderResult,
  CancelBatchItem,
  CancelBatchResponse,
  CancelBatchResult,
  Fill,
  Order,
  OrderSide,
  OrderType,
  TimeInForce,
  TriggerDirection,
} from "./types.js";

export const MAX_BATCH_ORDERS = 20;
export const MAX_CANCEL_ENTRIES = 50;
/**
 * The server's rule for a client order id (after it trims surrounding whitespace, which the SDK
 * refuses instead, so the id in a result is always the one sent). The SDK also refuses `.` and
 * `..`, which the server accepts but which cannot name the order in a lookup path.
 */
export const CLIENT_ORDER_ID_PATTERN = /^[A-Za-z0-9_\-.:]{1,64}$/;

/**
 * A new `client_order_id` (a UUID), the one `placeOrder` and `placeOrders` generate. Create and
 * save your ids with it before the call if you may need to reconcile after an error or an abort.
 */
export function newClientOrderId(): string {
  return newId();
}

/**
 * Attached to an error thrown by `placeOrders` (or `placeOrder`) once its body was built:
 * `clientOrderIds` are every id of the body in request order, generated ones included;
 * `maybePlaced` is false only when every attempt was a definite refusal (nothing was placed).
 * When it is true, look the orders up with `trading.orderByClientId` before placing again.
 */
export interface BatchPlaceErrorInfo {
  clientOrderIds: string[];
  maybePlaced: boolean;
}

/** The `BatchPlaceErrorInfo` on an error thrown by `placeOrders` / `placeOrder`, or null. */
export function batchPlaceErrorInfo(err: unknown): BatchPlaceErrorInfo | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Partial<BatchPlaceErrorInfo>;
  if (!Array.isArray(e.clientOrderIds) || typeof e.maybePlaced !== "boolean") return null;
  return { clientOrderIds: [...e.clientOrderIds], maybePlaced: e.maybePlaced };
}

/**
 * Returns `err` with `clientOrderIds` and `maybePlaced` set on it, its class kept, when the SDK
 * created it (a `CexyError`). Anything else (the caller's own abort reason, an authenticator's
 * error) is never written to: with `wrapForeign` it is wrapped in a `CexyError` that carries the
 * ids and has it as `cause`; without, it is returned unchanged.
 */
export function withBatchPlaceInfo(
  err: unknown,
  clientOrderIds: readonly string[],
  maybePlaced: boolean,
  wrapForeign = true,
): unknown {
  let target: unknown = err;
  if (!(err instanceof CexyError) || !Object.isExtensible(err)) {
    if (!wrapForeign) return err;
    const what = err instanceof Error ? err.message : String(err);
    target = new CexyError(`placeOrders failed: ${what}`, { cause: err });
  }
  const props = { clientOrderIds: [...clientOrderIds], maybePlaced };
  for (const [k, value] of Object.entries(props)) {
    Object.defineProperty(target, k, { value, enumerable: true, configurable: true, writable: true });
  }
  return target;
}

/**
 * Whether a placement that ended in `err` may have placed something: true after any ambiguous
 * attempt (the failing one included) and for any failure that is not an HTTP answer (a network
 * error, an abort, a timeout, an unusable 200). A local configuration error sent nothing.
 */
export function maybePlaced(err: unknown, attempts: readonly AttemptKind[]): boolean {
  if (attempts.includes("ambiguous")) return true;
  if (err instanceof CexyApiError) return attemptKind(err) === "ambiguous";
  return !(err instanceof CexyConfigError);
}

/** A 200 the SDK cannot use: not JSON, no `data`, or results that do not match the request. */
export class BatchResponseError extends CexyError {}

/**
 * The transport throws a plain `CexyError` (no subclass) only for a 2xx whose body is not JSON:
 * a batch call reports it as `BatchResponseError`, keeping the original as `cause`.
 */
export function asBatchResponseError(err: unknown): unknown {
  if (err instanceof CexyError && Object.getPrototypeOf(err) === CexyError.prototype) {
    return new BatchResponseError(err.message, { cause: err });
  }
  return err;
}

/** A lookup answer usable as an order: an object with a string `id` and `status`. */
export function isOrderLike(v: unknown): v is Order {
  return isObject(v) && typeof v["id"] === "string" && v["id"] !== "" && typeof v["status"] === "string" && v["status"] !== "";
}

const ORDER_AMOUNT_FIELDS = ["price", "quantity", "quote_quantity", "stop_price"] as const;
const ITEM_FIELDS = [
  "side",
  "type",
  "quantity",
  "price",
  "quote_quantity",
  "stop_price",
  "time_in_force",
  "trigger_direction",
] as const;

/**
 * One order for `trading.placeOrders`: a `placeOrder` request without `symbol`. Amounts are
 * decimal strings. `client_order_id` is optional: a UUID is generated when it is absent.
 */
export interface BatchOrderInput {
  side: OrderSide;
  type: OrderType;
  quantity?: string | null;
  price?: string | null;
  quote_quantity?: string | null;
  stop_price?: string | null;
  time_in_force?: TimeInForce | null;
  trigger_direction?: TriggerDirection | null;
  client_order_id?: string | null;
}

/** One entry for `trading.cancelOrders`: exactly one of `order_id` and `client_order_id`. */
export type CancelOrderEntry = { order_id: string; client_order_id?: null } | { client_order_id: string; order_id?: null };

/** What became of one order of `placeOrders`. See `BatchOrderOutcome.outcome`. */
export type PlaceOutcomeKind = "placed" | "failed" | "recovered" | "unknown";
/** What became of one entry of `cancelOrders`. See `CancelEntryOutcome.outcome`. */
export type CancelOutcomeKind = "cancelled" | "failed" | "recovered" | "unknown";

/** One order of `placeOrders`, in request order. */
export interface BatchOrderOutcome {
  /** Its position in the request, from 0. */
  index: number;
  /** The `client_order_id` sent (generated when you gave none). */
  client_order_id: string;
  /**
   * - `placed`: the server placed it now; `order` and `fills` are set.
   * - `failed`: refused; `error` says why. `ALREADY_EXISTS` here means the id was used before
   *   this call.
   * - `recovered`: an earlier attempt of this call placed it (its answer was lost), so the retry
   *   was answered `ALREADY_EXISTS`. `order_id` and `status` say what became of it; `order` is set
   *   only when the SDK had to look it up. A `rejected` status means it was refused (funds): its
   *   id is spent and it must not be placed again under that id.
   * - `unknown`: as `recovered`, but its state could not be read. It was not placed again; look
   *   it up with `trading.orderByClientId`.
   */
  outcome: PlaceOutcomeKind;
  order_id: string | null;
  status: string | null;
  order: Order | null;
  fills: Fill[];
  error: ErrorBody | null;
}

/**
 * What `placeOrders` did. The counts are computed from `results`, never copied from the server:
 * `placed` counts placed and recovered orders that were not rejected, `failed` the refused ones
 * (a recovered `rejected` included), `unknown` those whose state could not be read.
 */
export interface BatchPlaceResult {
  results: BatchOrderOutcome[];
  placed: number;
  failed: number;
  unknown: number;
}

/** One entry of `cancelOrders`, in request order. */
export interface CancelEntryOutcome {
  index: number;
  /**
   * `cancelled` (`order` is the cancelled order), `failed` (`error` says why), `recovered` (an
   * earlier attempt of this call may have cancelled it, so the retry was answered
   * `INVALID_STATE`; `order` is its current state and `status` says cancelled or, for example,
   * filled), or `unknown` (as recovered, but its state could not be read).
   */
  outcome: CancelOutcomeKind;
  order_id: string | null;
  client_order_id: string | null;
  status: string | null;
  order: Order | null;
  error: ErrorBody | null;
}

/**
 * What `cancelOrders` did. `cancelled` counts entries now cancelled (recovered ones included),
 * `failed` the rest that have a known state, `unknown` those that do not.
 */
export interface BatchCancelResult {
  results: CancelEntryOutcome[];
  cancelled: number;
  failed: number;
  unknown: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function checkClientOrderId(cid: unknown, where: string): string {
  if (typeof cid !== "string" || !CLIENT_ORDER_ID_PATTERN.test(cid) || cid === "." || cid === "..") {
    throw new CexyConfigError(`${where}: client_order_id must be 1 to 64 characters of A-Z a-z 0-9 _ - . : (not "." or "..")`);
  }
  return cid;
}

/**
 * Checks a `placeOrders` call and builds its body items, generating a `client_order_id` (with
 * `newId`) for each order without one. Called once, before the first attempt.
 */
export function buildPlaceItems(orders: readonly BatchOrderInput[], newId: () => string): BatchOrderItem[] {
  const list: unknown = orders;
  if (!Array.isArray(list) || orders.length < 1 || orders.length > MAX_BATCH_ORDERS) {
    const n = Array.isArray(list) ? orders.length : "none";
    throw new CexyConfigError(`placeOrders(): takes 1 to ${MAX_BATCH_ORDERS} orders, got ${n}`);
  }
  const seen = new Set<string>();
  orders.forEach((o, i) => {
    if (!isObject(o)) throw new CexyConfigError(`placeOrders(): orders[${i}] must be an object`);
    const cid = o["client_order_id"];
    if (cid === undefined || cid === null) return;
    checkClientOrderId(cid, `placeOrders(): orders[${i}]`);
    if (seen.has(cid)) {
      throw new CexyConfigError(`placeOrders(): orders[${i}]: client_order_id ${JSON.stringify(cid)} is used twice in this batch`);
    }
    seen.add(cid);
  });
  return orders.map((o, i) => {
    for (const f of ["side", "type"] as const) {
      if (!o[f]) throw new CexyConfigError(`placeOrders(): orders[${i}].${f} is required`);
    }
    assertAmountFields(o as unknown as Record<string, unknown>, ORDER_AMOUNT_FIELDS, `placeOrders(): orders[${i}]`);
    const item: Record<string, unknown> = {};
    for (const f of ITEM_FIELDS) {
      const v = o[f];
      if (v !== undefined && v !== null) item[f] = v;
    }
    item["client_order_id"] = o.client_order_id ?? newId();
    return item as BatchOrderItem;
  });
}

/** Checks a `cancelOrders` call and builds its body entries. */
export function buildCancelEntries(entries: readonly CancelOrderEntry[]): CancelBatchItem[] {
  const list: unknown = entries;
  if (!Array.isArray(list) || entries.length < 1 || entries.length > MAX_CANCEL_ENTRIES) {
    const n = Array.isArray(list) ? entries.length : "none";
    throw new CexyConfigError(`cancelOrders(): takes 1 to ${MAX_CANCEL_ENTRIES} entries, got ${n}`);
  }
  return entries.map((e, i) => {
    const oid: unknown = isObject(e) ? e["order_id"] : undefined;
    const cid: unknown = isObject(e) ? e["client_order_id"] : undefined;
    const given = (v: unknown) => v !== undefined && v !== null && v !== "";
    const id = given(oid) ? oid : cid;
    if (given(oid) === given(cid) || typeof id !== "string") {
      throw new CexyConfigError(`cancelOrders(): orders[${i}]: give exactly one of order_id and client_order_id`);
    }
    if (!given(oid) && (id === "." || id === "..")) {
      throw new CexyConfigError(`cancelOrders(): orders[${i}]: client_order_id must not be "." or ".."`);
    }
    return given(oid) ? { order_id: id } : { client_order_id: id };
  });
}

function detail(err: ErrorBody, name: string): string | null {
  const v = (err.details as Record<string, unknown> | null | undefined)?.[name];
  return typeof v === "string" && v !== "" ? v : null;
}

/** `details.status`, where "unknown" counts as missing so the order is looked up (rule 11). */
function detailStatus(err: ErrorBody): string | null {
  const v = detail(err, "status");
  return v === "unknown" ? null : v;
}

function statusOf(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Checks that a batch place answer matches the request: one result per order, in order, each
 * with the index and `client_order_id` sent. Anything else is an unusable answer.
 */
export function checkPlaceResponse(data: unknown, items: readonly BatchOrderItem[]): BatchOrderResponse {
  const results: unknown = isObject(data) ? data["results"] : undefined;
  if (!Array.isArray(results)) throw new BatchResponseError("placeOrders(): the answer has no results");
  if (results.length !== items.length) {
    throw new BatchResponseError(`placeOrders(): ${results.length} results for ${items.length} orders`);
  }
  results.forEach((r: unknown, i) => {
    if (!isObject(r) || r["index"] !== i || r["client_order_id"] !== items[i]?.client_order_id) {
      throw new BatchResponseError(`placeOrders(): result ${i} does not match the order sent at that position`);
    }
  });
  return data as BatchOrderResponse;
}

/**
 * As `checkPlaceResponse`, for a batch cancel: one result per entry, each with its index and the
 * `order_id` / `client_order_id` sent.
 */
export function checkCancelResponse(data: unknown, entries: readonly CancelBatchItem[]): CancelBatchResponse {
  const results: unknown = isObject(data) ? data["results"] : undefined;
  if (!Array.isArray(results)) throw new BatchResponseError("cancelOrders(): the answer has no results");
  if (results.length !== entries.length) {
    throw new BatchResponseError(`cancelOrders(): ${results.length} results for ${entries.length} entries`);
  }
  results.forEach((r: unknown, i) => {
    const e = entries[i];
    if (
      !isObject(r) ||
      r["index"] !== i ||
      (r["order_id"] ?? null) !== (e?.order_id ?? null) ||
      (r["client_order_id"] ?? null) !== (e?.client_order_id ?? null)
    ) {
      throw new BatchResponseError(`cancelOrders(): result ${i} does not match the entry sent at that position`);
    }
  });
  return data as CancelBatchResponse;
}

/**
 * Reads one place result. A recovered result still needing a lookup has `order_id` or `status`
 * null. An item error other than ALREADY_EXISTS that names an `order_id` (MARKET_UNAVAILABLE when
 * the market stopped while matching) means the order exists, on any attempt; an item INTERNAL may
 * follow a committed order, so it is looked up.
 */
export function placeFromResult(r: BatchOrderResult, afterAmbiguous: boolean): BatchOrderOutcome {
  const base = { index: r.index, client_order_id: r.client_order_id };
  const fills = r.fills ?? [];
  if (!r.error && r.order) {
    return { ...base, outcome: "placed", order_id: r.order.id, status: statusOf(r.order.status), order: r.order, fills, error: null };
  }
  const err = r.error ?? null;
  const live =
    err &&
    ((err.code === "ALREADY_EXISTS" && afterAmbiguous) ||
      (err.code !== "ALREADY_EXISTS" && detail(err, "order_id") !== null) ||
      err.code === "INTERNAL");
  if (err && live) {
    return {
      ...base,
      outcome: "recovered",
      order_id: detail(err, "order_id"),
      status: detailStatus(err),
      order: null,
      fills: [],
      error: err,
    };
  }
  return { ...base, outcome: "failed", order_id: null, status: null, order: null, fills, error: err };
}

export function needsLookup(o: BatchOrderOutcome): boolean {
  return o.outcome === "recovered" && (o.order_id === null || o.status === null);
}

/** A recovered place result completed by a lookup (`order` null: the lookup failed). */
export function placeRecovered(o: BatchOrderOutcome, order: Order | null): BatchOrderOutcome {
  if (!order) return { ...o, outcome: "unknown", order_id: null, status: null, order: null };
  return { ...o, outcome: "recovered", order_id: order.id, status: statusOf(order.status), order };
}

export function cancelFromResult(r: CancelBatchResult, afterAmbiguous: boolean): CancelEntryOutcome {
  const base = { index: r.index, order_id: r.order_id ?? null, client_order_id: r.client_order_id ?? null };
  if (!r.error && r.order) {
    return { ...base, outcome: "cancelled", order_id: r.order.id, status: statusOf(r.order.status), order: r.order, error: null };
  }
  const err = r.error ?? null;
  if (err && afterAmbiguous && err.code === "INVALID_STATE") {
    return { ...base, outcome: "recovered", status: null, order: null, error: err };
  }
  return { ...base, outcome: "failed", status: null, order: null, error: err };
}

/** A recovered cancel entry completed by its lookup (`order` null: the lookup failed). */
export function cancelRecovered(o: CancelEntryOutcome, order: Order | null): CancelEntryOutcome {
  if (!order) return { ...o, outcome: "unknown", status: null, order: null };
  return { ...o, outcome: "recovered", order_id: order.id, status: statusOf(order.status), order };
}

export function placeResult(results: BatchOrderOutcome[]): BatchPlaceResult {
  const placed = results.filter((o) => o.outcome === "placed" || (o.outcome === "recovered" && o.status !== "rejected")).length;
  const unknown = results.filter((o) => o.outcome === "unknown").length;
  return { results, placed, failed: results.length - placed - unknown, unknown };
}

export function cancelResult(results: CancelEntryOutcome[]): BatchCancelResult {
  const cancelled = results.filter((o) => o.outcome === "cancelled" || (o.outcome === "recovered" && o.status === "cancelled")).length;
  const unknown = results.filter((o) => o.outcome === "unknown").length;
  return { results, cancelled, failed: results.length - cancelled - unknown, unknown };
}
