import type Redis from 'ioredis';
import { GroupRateLimiter } from './group-rate-limiter';

function setup(evalResult: number) {
  const redis = { eval: jest.fn().mockResolvedValue(evalResult) };
  const limiter = new GroupRateLimiter(redis as unknown as Redis);
  return { limiter, redis };
}

/** Reads the ARGV the limiter passed to its Lua script. */
function argv(redis: { eval: jest.Mock }): string[] {
  return (redis.eval.mock.calls[0] as unknown[]).slice(3) as string[];
}

describe('GroupRateLimiter', () => {
  it('lets a free group through immediately', async () => {
    const { limiter } = setup(0);

    await expect(limiter.reserve('g1', 'vk')).resolves.toEqual({
      acquired: true,
      waitMs: 0,
    });
  });

  it('returns the wait a reserved slot requires', async () => {
    const { limiter } = setup(350);

    await expect(limiter.reserve('g1', 'vk')).resolves.toEqual({
      acquired: true,
      waitMs: 350,
    });
  });

  it('reports no reservation when the queue for a group is too long', async () => {
    // -1 is the script's "nothing consumed" answer, so the caller can requeue
    // without having burned a slot it will never use.
    const { limiter } = setup(-1);

    const result = await limiter.reserve('g1', 'vk');

    expect(result.acquired).toBe(false);
    expect(result.waitMs).toBeGreaterThan(0);
  });

  it('paces MAX more cautiously than VK, whose limit is documented', async () => {
    const { limiter: vkLimiter, redis: vkRedis } = setup(0);
    const { limiter: maxLimiter, redis: maxRedis } = setup(0);

    await vkLimiter.reserve('g1', 'vk');
    await maxLimiter.reserve('g2', 'max');

    const vkInterval = Number(argv(vkRedis)[1]);
    const maxInterval = Number(argv(maxRedis)[1]);
    expect(maxInterval).toBeGreaterThan(vkInterval);
    // VK documents roughly 3 requests/second for a community token.
    expect(vkInterval).toBeGreaterThanOrEqual(1000 / 3);
  });

  it('keys the window per group, so groups never throttle each other', async () => {
    const { limiter, redis } = setup(0);

    await limiter.reserve('group-abc', 'vk');

    const key = (redis.eval.mock.calls[0] as unknown[])[2] as string;
    expect(key).toContain('group-abc');
  });

  it('gives the key an expiry so idle groups do not leak keys', async () => {
    const { limiter, redis } = setup(0);

    await limiter.reserve('g1', 'vk');

    expect(Number(argv(redis)[3])).toBeGreaterThan(0);
  });
});
