import { CexyConfigError } from "./errors.js";

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True for loopback hosts, the only ones where plain-text transport may be allowed. */
export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

/**
 * Requires `secure` (https:/wss:). `insecure` (http:/ws:) is accepted only with
 * `allowInsecure` AND a loopback host. Credentials must never travel in clear text.
 */
export function assertSecureUrl(url: URL, secure: string, insecure: string, allowInsecure: boolean, what: string): void {
  if (url.protocol === secure) return;
  if (url.protocol === insecure) {
    if (!allowInsecure) {
      throw new CexyConfigError(`${what} must use ${secure}// (pass allowInsecure: true only for a local test server)`);
    }
    if (!isLocalHost(url.hostname)) {
      throw new CexyConfigError(`${what}: ${insecure}// is only allowed for localhost, 127.0.0.1 or ::1`);
    }
    return;
  }
  throw new CexyConfigError(`${what} must use ${secure}//`);
}
