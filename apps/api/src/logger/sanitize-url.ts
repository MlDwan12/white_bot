const SENSITIVE_QUERY_KEYS = ['access_token', 'token', 'password'];

/**
 * Masks sensitive query-string values in a URL (e.g. VK's `access_token`
 * passed as a GET parameter) so they never reach a log line as plain text.
 * pino's `redact` option only reaches parsed objects — the raw `req.url`
 * string needs its own sanitization.
 *
 * Only redacts top-level query keys — a secret embedded inside the *value*
 * of another param (e.g. a forwarded `redirect_uri=...?access_token=...`)
 * is preserved as-is, not scrubbed. Good enough for our own callback URLs;
 * revisit if we ever proxy a third-party URL carrying its own secrets.
 */
export function sanitizeUrl(url: string): string {
  // Split on the *first* '?' only — a query string may legally contain a
  // literal, unescaped '?' in a value, and url.split('?') would silently
  // drop everything after a second one instead of sanitizing it.
  const separatorIndex = url.indexOf('?');
  if (separatorIndex === -1) return url;

  const path = url.slice(0, separatorIndex);
  const query = url.slice(separatorIndex + 1);

  const params = new URLSearchParams(query);
  for (const key of SENSITIVE_QUERY_KEYS) {
    if (params.has(key)) {
      params.set(key, '[REDACTED]');
    }
  }
  return `${path}?${params.toString()}`;
}
