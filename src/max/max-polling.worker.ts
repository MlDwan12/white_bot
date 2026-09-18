import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Bot } from '@maxhub/max-bot-api';
import { PinoLogger } from 'nestjs-pino';
import { MaxBotHandlers } from './max-bot.handlers';
import { MAX_BOT } from './max-bot.provider';

/**
 * Owns the bot's lifetime: registers handlers, starts MAX long polling on
 * boot and stops it on shutdown (the app already runs with
 * `enableShutdownHooks`, so this fires on SIGTERM too).
 *
 * Long polling rather than a webhook — a deliberate choice from PLAN.md: it
 * needs no public inbound address, which is what lets this run anywhere.
 *
 * Single-instance by construction: two processes polling the same bot token
 * would each receive a slice of the updates and ACK them via the shared
 * `marker` cursor, so events would be processed by whichever replica won the
 * race. Before scaling horizontally, polling must move behind a leader lock
 * or into a dedicated single-replica worker.
 */
@Injectable()
export class MaxPollingWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private started = false;

  constructor(
    @Inject(MAX_BOT) private readonly bot: Bot | null,
    private readonly handlers: MaxBotHandlers,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MaxPollingWorker.name);
  }

  onApplicationBootstrap(): void {
    if (!this.bot) {
      this.logger.warn(
        'MAX_BOT_TOKEN не задан — long polling MAX не запущен, интеграция с MAX отключена',
      );
      return;
    }

    this.handlers.register();

    // `start()`, not `startPolling()`: the latter dereferences `this.botInfo`
    // unguarded, and only `start()` populates it (via getMyInfo). Calling
    // startPolling directly throws a TypeError that the SDK swallows into its
    // own 5s retry loop — polling would silently never run, while this worker
    // logged that it had started. `botInfo` is also what command matching
    // needs to recognise `/cmd@botname` in group chats.
    //
    // Not awaited on purpose: the returned promise settles only if startup
    // itself fails (a bad token, an unreachable API) — once polling is
    // running it stays pending until shutdown, so awaiting it here would
    // block the bootstrap hook and the app would never finish starting.
    void this.bot
      .start({ mode: 'polling' })
      .catch((err: unknown) =>
        this.logger.error({ err }, 'Не удалось запустить long polling MAX'),
      );
    this.started = true;
    this.logger.info('Long polling MAX запущен');
  }

  onApplicationShutdown(): void {
    if (!this.bot || !this.started) {
      return;
    }
    this.bot.stopPolling();
    this.started = false;
    this.logger.info('Long polling MAX остановлен');
  }
}
