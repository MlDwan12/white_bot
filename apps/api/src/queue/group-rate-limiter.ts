import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { Platform } from '../generated/prisma/client';
import { REDIS_CLIENT } from './queue.constants';

/**
 * Minimum gap between two calls to the same group.
 *
 * VK's documented ceiling for a community token is ~3 requests/second, so 350ms
 * leaves a margin. MAX publishes no limits at all (checked against their docs
 * in Step 5), so it starts deliberately slower until real traffic tells us
 * otherwise — being too slow costs seconds, being too fast costs a ban.
 */
const MIN_INTERVAL_MS: Record<Platform, number> = {
  vk: 350,
  max: 500,
};

/**
 * How long a worker is willing to hold its slot waiting. Beyond this the job
 * is put back with a delay instead, freeing the worker for another group.
 */
const MAX_INPLACE_WAIT_MS = 2_000;

/** Key expiry: long enough to outlive the gap, short enough not to leak keys. */
const KEY_TTL_MS = 60_000;

/**
 * Atomically reserves the next call slot for one group.
 *
 * Reads the group's "next free moment", moves it forward by one interval and
 * returns how long the caller must wait. Being a single Lua script makes it
 * race-free: two workers reserving at once get two consecutive slots rather
 * than the same one, which a GET-then-SET pair could not guarantee.
 *
 * If the wait would exceed the cap, nothing is consumed and -1 is returned —
 * so a caller that requeues doesn't burn a slot it will never use.
 */
const RESERVE_SLOT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local maxWait = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local nextFree = tonumber(redis.call('GET', key) or '0')
local slot = math.max(now, nextFree)
local wait = slot - now

if wait > maxWait then
  return -1
end

redis.call('SET', key, slot + interval, 'PX', ttl)
return wait
`;

export interface SlotReservation {
  /** True when a slot was taken and the caller may proceed after `waitMs`. */
  acquired: boolean;
  /** With `acquired`, how long to wait first; otherwise, when to try again. */
  waitMs: number;
}

/**
 * Per-group (that is, per-token) pacing of platform calls.
 *
 * Deliberately not BullMQ's own limiter: that one is per-worker and global, so
 * it would throttle every group together — exactly what PLAN.md rules out,
 * since different VK communities have different tokens and can be called in
 * parallel. What must be paced is repeated calls into the *same* group.
 */
@Injectable()
export class GroupRateLimiter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async reserve(
    groupId: string,
    platform: Platform,
    now: number = Date.now(),
  ): Promise<SlotReservation> {
    const interval = MIN_INTERVAL_MS[platform];
    const result = (await this.redis.eval(
      RESERVE_SLOT_SCRIPT,
      1,
      this.key(groupId),
      String(now),
      String(interval),
      String(MAX_INPLACE_WAIT_MS),
      String(KEY_TTL_MS),
    )) as number;

    return result < 0
      ? { acquired: false, waitMs: MAX_INPLACE_WAIT_MS }
      : { acquired: true, waitMs: result };
  }

  private key(groupId: string): string {
    return `ratelimit:group:${groupId}`;
  }
}
