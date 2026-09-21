/**
 * DI token for the raw Redis client.
 *
 * Lives here rather than in queue.module.ts on purpose: the module imports
 * GroupRateLimiter, so a token declared there and imported back by the limiter
 * forms an import cycle — at runtime the token resolves to `undefined` and
 * Nest fails with an unhelpful "undefined dependency".
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export const POST_DELIVERY_QUEUE = 'post-delivery';

export const JOB_DISPATCH_POST = 'dispatch-post';
export const JOB_DELIVER = 'deliver';

/**
 * Job payloads carry an id and nothing else. Everything the worker needs is
 * read from Postgres when the job actually runs, so a post edited between
 * scheduling and sending goes out with its current content — a snapshot in
 * the payload would silently publish the stale version. It also keeps Redis
 * free of business data, which matters because Postgres is the source of
 * truth and Redis is treated as a rebuildable cache.
 */
export interface DispatchPostJob {
  postId: string;
}

export interface DeliverJob {
  deliveryId: string;
}

/**
 * Stable job ids make re-enqueueing idempotent: BullMQ ignores a duplicate id.
 *
 * Separated by `-`, not `:` — BullMQ builds its own Redis keys around colons
 * and rejects a custom id containing one outright ("Custom Id cannot contain
 * :"), which surfaces only when a job is actually added.
 */
export function dispatchJobId(postId: string): string {
  return `dispatch-${postId}`;
}

export function deliverJobId(deliveryId: string): string {
  return `deliver-${deliveryId}`;
}

export const DIRECT_MESSAGE_QUEUE = 'direct-message-delivery';

export const JOB_DELIVER_DIRECT_MESSAGE = 'deliver-direct-message';

export interface DeliverDirectMessageJob {
  deliveryId: string;
}

export function deliverDirectMessageJobId(deliveryId: string): string {
  return `deliver-dm-${deliveryId}`;
}
