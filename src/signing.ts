import { type AuthRequest, type Authenticator } from "./auth.js";
import { CexyConfigError } from "./errors.js";

/**
 * HMAC request signing (`CEXY-HMAC-SHA256-v1`): the default (`auth: "hmac"`). The API refuses the
 * old secret header with `SIGNATURE_REQUIRED`.
 *
 * Canonical request: 7 lines joined by "\n" (no trailing newline): the scheme, the method, the
 * canonical path, the canonical query, the timestamp (unix ms), the nonce and the hex SHA-256 of
 * the exact body bytes. Signature: lowercase hex HMAC-SHA256 keyed with the UTF-8 bytes of the
 * secret string as issued (never decoded).
 */
export const SIGNING_SCHEME = "CEXY-HMAC-SHA256-v1";

/** The furthest the client clock may be corrected (`SIGNATURE_EXPIRED` offsets beyond fail). */
export const MAX_CLOCK_OFFSET_MS = 60 * 60 * 1000;

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const enc = new TextEncoder();

/** RFC 3986 encoding of raw bytes: unreserved kept, everything else `%XX` with uppercase hex. */
function encodeBytes(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    out += b < 0x80 && UNRESERVED.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Percent-decodes to raw bytes (a `%` not followed by two hex digits is kept literally). */
function decodeToBytes(s: string): Uint8Array {
  const out: number[] = [];
  const raw = Array.from(enc.encode(s));
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] ?? 0;
    const pair = raw.slice(i + 1, i + 3);
    if (b === 0x25 && pair.length === 2) {
      const hexPair = String.fromCharCode(...pair);
      if (/^[0-9A-Fa-f]{2}$/.test(hexPair)) {
        out.push(parseInt(hexPair, 16));
        i += 2;
        continue;
      }
    }
    out.push(b);
  }
  return Uint8Array.from(out);
}

/** An RFC 3986 encoding of a string (UTF-8), for building paths and queries the SDK sends. */
export function encodeComponent(s: string): string {
  return encodeBytes(enc.encode(s));
}

/** Canonical path: split on "/" BEFORE decoding; each segment decoded, then re-encoded. */
export function canonicalPath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeBytes(decodeToBytes(seg)))
    .join("/");
}

/**
 * Canonical query: split on "&" (empty parts dropped); decode and re-encode names and values; sort
 * bytewise. `query` is everything after the FIRST "?" of the request target, so a further "?" is
 * data.
 */
export function canonicalQuery(query: string): string {
  if (query === "") return "";
  const parts = query.split("&").filter((part) => part !== ""); // "a=1&&b=2" is "a=1&b=2"
  const pairs = parts.map((part) => {
    const eq = part.indexOf("=");
    const name = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? "" : part.slice(eq + 1);
    return [encodeBytes(decodeToBytes(name)), encodeBytes(decodeToBytes(value))] as const;
  });
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // ASCII-only: bytewise
  pairs.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  return pairs.map(([n, v]) => `${n}=${v}`).join("&");
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new CexyConfigError("request signing needs Web Crypto (globalThis.crypto.subtle): Node 20+ or a browser");
  return s;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await subtle().digest("SHA-256", bytes as BufferSource));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await subtle().importKey("raw", enc.encode(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await subtle().sign("HMAC", key, enc.encode(message)));
}

/** The canonical request for `method`, the path and query as sent, and the exact body. */
export async function canonicalRequest(
  method: string,
  path: string,
  query: string,
  timestamp: string,
  nonce: string,
  body: string | undefined,
): Promise<string> {
  return [
    SIGNING_SCHEME,
    method.toUpperCase(),
    canonicalPath(path),
    canonicalQuery(query),
    timestamp,
    nonce,
    await sha256Hex(body ?? ""),
  ].join("\n");
}

/** A 16-byte CSPRNG nonce, base64url without padding (22 characters). */
export function newNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface HmacAuthenticatorOptions {
  /** @internal tests: fixed clock */
  now?: () => number;
  /** @internal tests: fixed nonce */
  nonce?: () => string;
}

/**
 * Signs every private request (see `SIGNING_SCHEME`). The secret never leaves
 * the process: only `X-API-Key`, `X-API-Timestamp`, `X-API-Nonce` and `X-API-Signature` are sent.
 * Called once per attempt, so every retry has a fresh timestamp and nonce.
 */
export class HmacAuthenticator implements Authenticator {
  readonly kind = "hmac";
  readonly #key: string;
  readonly #secret: string;
  readonly #now: () => number;
  readonly #nonce: () => string;
  #offsetMs = 0;

  constructor(apiKey: string, apiSecret: string, options: HmacAuthenticatorOptions = {}) {
    if (typeof apiKey !== "string" || apiKey.trim() === "") throw new CexyConfigError("apiKey must be a non-empty string");
    if (typeof apiSecret !== "string" || apiSecret.trim() === "")
      throw new CexyConfigError("apiSecret must be a non-empty string");
    if (/[\r\n]/.test(apiKey) || /[\r\n]/.test(apiSecret))
      throw new CexyConfigError("apiKey and apiSecret must not contain line breaks");
    this.#key = apiKey;
    this.#secret = apiSecret;
    this.#now = options.now ?? Date.now;
    this.#nonce = options.nonce ?? newNonce;
  }

  /** The correction applied to the local clock after `SIGNATURE_EXPIRED` (diagnostics). */
  get clockOffsetMs(): number {
    return this.#offsetMs;
  }

  /**
   * Adopts the server's clock after `SIGNATURE_EXPIRED` (`details.server_time_ms`). Returns false
   * (and changes nothing) when the correction would exceed `MAX_CLOCK_OFFSET_MS`.
   */
  adjustClock(serverTimeMs: number): boolean {
    const offset = Math.round(serverTimeMs - this.#now());
    if (!Number.isFinite(offset) || Math.abs(offset) > MAX_CLOCK_OFFSET_MS) return false;
    this.#offsetMs = offset;
    return true;
  }

  async authenticate(request: AuthRequest): Promise<void> {
    const timestamp = String(this.#now() + this.#offsetMs);
    const nonce = this.#nonce();
    const canonical = await canonicalRequest(request.method, request.url.pathname, request.url.search.slice(1), timestamp, nonce, request.body);
    request.headers.delete("X-API-Secret");
    request.headers.set("X-API-Key", this.#key);
    request.headers.set("X-API-Timestamp", timestamp);
    request.headers.set("X-API-Nonce", nonce);
    request.headers.set("X-API-Signature", await hmacSha256Hex(this.#secret, canonical));
  }

  /** The WebSocket `auth_key` signature for a connection id and a server challenge. */
  async signWebSocketChallenge(connectionId: string, challenge: string): Promise<{ keyId: string; signature: string }> {
    return { keyId: this.#key, signature: await hmacSha256Hex(this.#secret, `CEXY-WS-AUTH-v1\n${connectionId}\n${challenge}`) };
  }

  redact(text: string): string {
    let out = text;
    for (const s of [this.#secret, this.#key]) if (s) out = out.split(s).join("[REDACTED]");
    return out;
  }

  get keyHint(): string {
    return `${this.#key.slice(0, 6)}…`;
  }

  toString(): string {
    return `HmacAuthenticator(${this.keyHint}, secret=[REDACTED])`;
  }

  toJSON(): Record<string, string> {
    return { kind: this.kind, apiKey: this.keyHint, apiSecret: "[REDACTED]" };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
