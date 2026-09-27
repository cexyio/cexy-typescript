import type { components } from "./generated/schema.js";

/**
 * Every `error.code` the API is known to return (from cexy-api-spec/errors.yaml, PROVISIONAL
 * until the served spec includes the ErrorCode schema). New codes can appear at any time, so
 * the type stays open: always keep a default branch when switching on it.
 */
export type KnownErrorCode = components["schemas"]["ErrorCode"];
export type ErrorCode = KnownErrorCode | (string & {});

/** The `error` object of the API's error envelope. */
export type ErrorBody = components["schemas"]["ErrorBody"];

/** Base class for everything the SDK throws. */
export class CexyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid client configuration, detected locally before any request is sent. */
export class CexyConfigError extends CexyError {}

/**
 * A JS `number` (or a malformed string) was passed where the API expects a decimal string.
 * Thrown before sending: numbers are IEEE-754 doubles and silently corrupt amounts.
 */
export class InvalidAmountError extends CexyError {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/** The request never produced an HTTP response (DNS, TLS, connection reset, ...). */
export class CexyConnectionError extends CexyError {
  readonly retryable = true;
}

/** The request exceeded `timeoutMs`. */
export class CexyTimeoutError extends CexyConnectionError {}

/**
 * `placeOrder` failed ambiguously (network error or 5xx), and looking the order up by its
 * `client_order_id` also failed, so it is unknown whether the order exists.
 * Check `trading.orderByClientId(clientOrderId)` before placing it again.
 */
export class OrderStateUnknownError extends CexyError {
  readonly clientOrderId: string;
  constructor(clientOrderId: string, cause: unknown) {
    super(
      `order state unknown for client_order_id ${clientOrderId}; check trading.orderByClientId() before retrying`,
      { cause },
    );
    this.clientOrderId = clientOrderId;
  }
}

export interface CexyApiErrorInit {
  status: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown> | undefined;
  fields?: Record<string, string> | undefined;
  requestId?: string | null | undefined;
  retryable: boolean;
  headers?: Headers | undefined;
}

/** An error response from the API (the `{"error": {...}}` envelope). Branch on `code`. */
export class CexyApiError extends CexyError {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly fields: Record<string, string>;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(init: CexyApiErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? {};
    this.fields = init.fields ?? {};
    this.requestId = init.requestId ?? null;
    this.retryable = init.retryable;
  }

  override toString(): string {
    const rid = this.requestId ? ` (request_id ${this.requestId})` : "";
    return `${this.name}: [${this.status} ${this.code}] ${this.message}${rid}`;
  }
}

/** 401: missing or invalid credentials (`UNAUTHENTICATED`, `INVALID_CREDENTIALS`, ...). */
export class AuthenticationError extends CexyApiError {}
/** 403: the key lacks a scope (`FORBIDDEN`), or the route is session-only (`API_KEY_NOT_ALLOWED`). */
export class ForbiddenError extends CexyApiError {}
/**
 * 451: not available in the caller's jurisdiction (`JURISDICTION_BLOCKED`). A `ForbiddenError`
 * subclass, so existing `instanceof ForbiddenError` checks still match. Retrying will not help.
 */
export class JurisdictionBlockedError extends ForbiddenError {}
/** 404 */
export class NotFoundError extends CexyApiError {}
/** 400: the request failed validation; see `fields`. */
export class ValidationError extends CexyApiError {}
/** 409: `ALREADY_EXISTS`, `IDEMPOTENCY_KEY_CONFLICT`, `CONCURRENT_MODIFICATION`, ... */
export class ConflictError extends CexyApiError {}
/** 422: a business rule refused the request (`INSUFFICIENT_FUNDS`, `MARKET_UNAVAILABLE`, ...). */
export class UnprocessableError extends CexyApiError {}
/** 429: rate limited. `retryAfterMs` is how long the server asked to wait. */
export class RateLimitError extends CexyApiError {
  readonly retryAfterMs: number | null;
  constructor(init: CexyApiErrorInit, retryAfterMs: number | null) {
    super(init);
    this.retryAfterMs = retryAfterMs;
  }
}
/** 5xx */
export class ServerError extends CexyApiError {}

const STATUS_CLASSES: Record<number, typeof CexyApiError> = {
  400: ValidationError,
  401: AuthenticationError,
  403: ForbiddenError,
  404: NotFoundError,
  451: JurisdictionBlockedError, // unavailable for legal reasons
  409: ConflictError,
  422: UnprocessableError,
};

const KNOWN_CODES: ReadonlySet<string> = new Set<KnownErrorCode>([
  "VALIDATION_FAILED", "MALFORMED_REQUEST", "INVALID_CURSOR", "PRECISION_EXCEEDED", "BELOW_MINIMUM",
  "ABOVE_MAXIMUM", "INVALID_ADDRESS", "MEMO_REQUIRED", "UNAUTHENTICATED", "INVALID_CREDENTIALS",
  "TOKEN_EXPIRED", "SESSION_REVOKED", "TWO_FACTOR_REQUIRED", "TWO_FACTOR_INVALID",
  "FRESH_TWO_FACTOR_REQUIRED", "FORBIDDEN", "API_KEY_NOT_ALLOWED", "FUTURES_RESTRICTED",
  "ACCOUNT_FROZEN", "ACCOUNT_ON_HOLD", "EMAIL_NOT_VERIFIED", "REGION_BLOCKED", "JURISDICTION_BLOCKED", "NOT_FOUND",
  "METHOD_NOT_ALLOWED", "ALREADY_EXISTS", "INVALID_STATE", "IDEMPOTENCY_KEY_CONFLICT", "WINDOW_OPEN",
  "EVIDENCE_CONTRADICTS", "AMOUNT_MISMATCH", "CONCURRENT_MODIFICATION", "INSUFFICIENT_FUNDS",
  "INSUFFICIENT_FEE_FUNDS", "MARKET_UNAVAILABLE", "DEPOSIT_DISABLED", "WITHDRAWAL_DISABLED",
  "SELF_TRADE_BLOCKED", "LIMIT_EXCEEDED", "RATE_LIMITED", "INTERNAL", "SERVICE_UNAVAILABLE",
  "UNDER_MAINTENANCE", "ENGINE_OVERLOADED",
]);

/**
 * Codes the SDK itself sets on a `CexyApiError`; the API never sends them, so they are not in
 * errors.yaml and `isKnownErrorCode()` returns false for them.
 * - `UNEXPECTED_REDIRECT`: the server answered with a 3xx. The SDK never follows redirects (the
 *   credentials would go to the redirect target); not retryable.
 */
export const CLIENT_ERROR_CODES = { UNEXPECTED_REDIRECT: "UNEXPECTED_REDIRECT" } as const;

/** True for codes listed in errors.yaml (server codes; see `CLIENT_ERROR_CODES` for the SDK's own). */
export function isKnownErrorCode(code: string): code is KnownErrorCode {
  return KNOWN_CODES.has(code);
}

const DEFAULT_RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Parses `Retry-After` (seconds or HTTP date) and `details.retry_after_seconds`; returns ms. */
export function retryAfterMs(headers: Headers | undefined, details: Record<string, unknown> | undefined): number | null {
  let best: number | null = null;
  const h = headers?.get("retry-after");
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) best = Math.max(0, secs * 1000);
    else {
      const at = Date.parse(h);
      if (!Number.isNaN(at)) best = Math.max(0, at - Date.now());
    }
  }
  const d = details?.["retry_after_seconds"];
  const ds = typeof d === "number" ? d : typeof d === "string" ? Number(d) : NaN;
  if (Number.isFinite(ds)) best = Math.max(best ?? 0, ds * 1000);
  return best;
}

/**
 * Builds the right error subclass for an HTTP error response.
 * - A known code maps by HTTP status (401 -> AuthenticationError, 403 -> ForbiddenError, ...).
 * - An unknown code maps to the base `CexyApiError` (never a crash).
 * - A body without the envelope (a proxy error page) maps by status with code `HTTP_<status>`.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers?: Headers,
  redact: (text: string) => string = (t) => t,
): CexyApiError {
  const env = extractEnvelope(body);
  if (env) env.message = redact(env.message);
  const init: CexyApiErrorInit = env
    ? {
        status,
        code: env.code,
        message: env.message,
        details: env.details,
        fields: env.fields,
        requestId: env.request_id ?? headers?.get("x-request-id") ?? null,
        retryable: typeof env.retryable === "boolean" ? env.retryable : DEFAULT_RETRYABLE_STATUS.has(status),
        headers,
      }
    : {
        status,
        code: `HTTP_${status}`,
        message: `HTTP ${status}`,
        requestId: headers?.get("x-request-id") ?? null,
        retryable: DEFAULT_RETRYABLE_STATUS.has(status),
        headers,
      };

  if (status === 429 || init.code === "RATE_LIMITED") {
    return new RateLimitError(init, retryAfterMs(headers, init.details));
  }
  if (init.code === "JURISDICTION_BLOCKED") return new JurisdictionBlockedError(init);
  if (env && !isKnownErrorCode(env.code)) return new CexyApiError(init);
  if (status >= 500) return new ServerError(init);
  const Cls = STATUS_CLASSES[status] ?? CexyApiError;
  return new Cls(init);
}

interface Envelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  fields?: Record<string, string>;
  request_id?: string | null;
  retryable?: boolean;
}

function extractEnvelope(body: unknown): Envelope | null {
  if (!body || typeof body !== "object") return null;
  const e = (body as { error?: unknown }).error;
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  if (typeof o["code"] !== "string") return null;
  return {
    code: o["code"],
    message: typeof o["message"] === "string" ? o["message"] : o["code"],
    details: isRecord(o["details"]) ? o["details"] : undefined,
    fields: isRecord(o["fields"]) ? (o["fields"] as Record<string, string>) : undefined,
    request_id: typeof o["request_id"] === "string" ? o["request_id"] : null,
    retryable: typeof o["retryable"] === "boolean" ? o["retryable"] : undefined,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
