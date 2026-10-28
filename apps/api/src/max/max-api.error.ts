/**
 * Wraps a failure from the MAX Bot API. Mirrors VkApiError so both platform
 * clients surface the same shape to the services above them.
 *
 * `code` is MAX's own string code (e.g. `verify.token`, `chat.not.found`)
 * rather than a number — unlike VK, MAX identifies errors by string. `status`
 * is the HTTP status, kept separately because the delivery pipeline decides
 * what to do from it.
 *
 * Deliberately carries no `retryable` flag of its own: whether a failure may
 * be retried is delivery policy, and it lives in one place
 * (`classifyDeliveryError`). Two notions of "retryable" in the codebase would
 * eventually disagree, and the safe answer here is subtler than a boolean —
 * see the comment there about duplicate posts.
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

  /** The bot token is missing/revoked — the group can't be delivered to at all. */
  get tokenInvalid(): boolean {
    return this.status === 401;
  }
}
