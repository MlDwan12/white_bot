/**
 * Wraps a failure from the MAX Bot API. Mirrors VkApiError so both platform
 * clients surface the same shape to the services above them.
 *
 * `code` is MAX's own string code (e.g. `verify.token`, `chat.not.found`)
 * rather than a number — unlike VK, MAX identifies errors by string. `status`
 * is the HTTP status, kept separately because retry decisions key off it
 * (429/5xx are retryable, 4xx are not).
 */
export class MaxApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MaxApiError';
  }

  /**
   * A failure worth retrying: rate limiting, a server-side fault, or a
   * transport error that never reached MAX (status 0 — DNS, TLS, timeout).
   * A 4xx means MAX understood us and said no, so retrying it just burns
   * rate-limit budget.
   */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  /** The bot token is missing/revoked — the group can't be delivered to at all. */
  get tokenInvalid(): boolean {
    return this.status === 401;
  }
}
