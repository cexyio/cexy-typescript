import { CexyConfigError } from "./errors.js";

/** The parts of an outgoing request an authenticator may read or change. */
export interface AuthRequest {
  readonly method: string;
  /** Full URL including the query string. Credentials must never be added to it. */
  readonly url: URL;
  readonly headers: Headers;
  /** The exact body bytes that will be sent (JSON text), if any. */
  readonly body: string | undefined;
}

/**
 * Adds credentials to requests for operations that need an API key.
 *
 * Called once per attempt (retries included), so a future signing implementation can put a
 * fresh timestamp and nonce on each attempt. It is never called for public operations.
 */
export interface Authenticator {
  /** Short, non-secret description, e.g. `"api-key"`. */
  readonly kind: string;
  authenticate(request: AuthRequest): void | Promise<void>;
  /** Removes any secret material from `text` (used on error messages and logs). */
  redact(text: string): string;
}

const REDACTED = "[REDACTED]";

/**
 * Today's scheme: `X-API-Key` and `X-API-Secret` headers on every private request.
 * HMAC request signing (`auth: "hmac"`, `HmacAuthenticator`) is the other scheme.
 */
export class ApiKeyAuthenticator implements Authenticator {
  readonly kind = "api-key";
  readonly #key: string;
  readonly #secret: string;

  constructor(apiKey: string, apiSecret: string) {
    if (typeof apiKey !== "string" || apiKey.trim() === "") throw new CexyConfigError("apiKey must be a non-empty string");
    if (typeof apiSecret !== "string" || apiSecret.trim() === "")
      throw new CexyConfigError("apiSecret must be a non-empty string");
    if (/[\r\n]/.test(apiKey) || /[\r\n]/.test(apiSecret))
      throw new CexyConfigError("apiKey and apiSecret must not contain line breaks");
    this.#key = apiKey;
    this.#secret = apiSecret;
  }

  /** A non-secret hint for logs: the first characters of the key id. */
  get keyHint(): string {
    return `${this.#key.slice(0, 6)}…`;
  }

  authenticate(request: AuthRequest): void {
    request.headers.set("X-API-Key", this.#key);
    request.headers.set("X-API-Secret", this.#secret);
  }

  redact(text: string): string {
    let out = text;
    for (const s of [this.#secret, this.#key]) {
      if (s) out = out.split(s).join(REDACTED);
    }
    return out;
  }

  toString(): string {
    return `ApiKeyAuthenticator(${this.keyHint}, secret=${REDACTED})`;
  }

  toJSON(): Record<string, string> {
    return { kind: this.kind, apiKey: this.keyHint, apiSecret: REDACTED };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
