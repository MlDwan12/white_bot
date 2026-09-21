import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import Redis from 'ioredis';
import { GroupRateLimiter } from './group-rate-limiter';
import {
  DIRECT_MESSAGE_QUEUE,
  POST_DELIVERY_QUEUE,
  REDIS_CLIENT,
} from './queue.constants';

/**
 * Queue infrastructure: the BullMQ connection, the delivery queue itself, and
 * the per-group rate limiter that sits in front of every platform call.
 *
 * Global because both the posts module and the reconciler need the raw Redis
 * client, and threading it through every importer adds noise without adding
 * clarity.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.getOrThrow<string>('REDIS_URL'),
          // Required by BullMQ for worker connections: with a retry cap the
          // blocking commands a worker relies on would throw once the cap is
          // hit instead of waiting through a Redis hiccup.
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue({ name: POST_DELIVERY_QUEUE }),
    BullModule.registerQueue({ name: DIRECT_MESSAGE_QUEUE }),
  ],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), {
          // Deliberately NOT `maxRetriesPerRequest: null` here. That setting
          // is required for BullMQ's blocking worker connections (above), but
          // on a general-purpose client it means commands are never rejected:
          // while Redis is unreachable the rate limiter's reserve() would
          // never settle, every worker slot would park forever with no error
          // logged, and `quit()` on shutdown could hang too. The default cap
          // turns an outage into a visible failure instead of a silent stall.
          commandTimeout: 5_000,
        }),
    },
    GroupRateLimiter,
  ],
  exports: [BullModule, REDIS_CLIENT, GroupRateLimiter],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * BullMQ closes the connections it opened itself, but the raw client above
   * is ours — without this it stays connected after shutdown, holding the
   * Node process open (which is exactly how the e2e run first hung).
   */
  async onApplicationShutdown(): Promise<void> {
    // `disconnect()` as the fallback, because a `quit()` that can't reach
    // Redis must not keep the process alive.
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
