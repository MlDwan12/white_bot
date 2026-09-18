import { Bot } from '@maxhub/max-bot-api';
import { PinoLogger } from 'nestjs-pino';
import { MaxBotHandlers } from './max-bot.handlers';
import { MaxPollingWorker } from './max-polling.worker';

function setup(bot: Partial<Bot> | null) {
  const handlers = { register: jest.fn() };
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const worker = new MaxPollingWorker(
    bot as Bot | null,
    handlers as unknown as MaxBotHandlers,
    logger as unknown as PinoLogger,
  );
  return { worker, handlers, logger };
}

describe('MaxPollingWorker', () => {
  it('starts through start(), which is what populates botInfo', () => {
    // `startPolling()` alone dereferences `this.botInfo.username` unguarded,
    // and only `start()` fetches it. Called directly it throws a TypeError
    // that the SDK swallows into its own 5s retry loop: polling would never
    // run, no update would ever arrive, and nothing would surface the fault.
    const start = jest.fn().mockReturnValue(new Promise(() => {}));
    const startPolling = jest.fn();
    const { worker, handlers } = setup({ start, startPolling });

    worker.onApplicationBootstrap();

    expect(start).toHaveBeenCalledWith({ mode: 'polling' });
    expect(startPolling).not.toHaveBeenCalled();
    expect(handlers.register).toHaveBeenCalled();
  });

  it('logs a startup failure instead of leaving it unhandled', async () => {
    const start = jest.fn().mockRejectedValue(new Error('invalid token'));
    const { worker, logger } = setup({ start });

    worker.onApplicationBootstrap();
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalled();
  });

  it('degrades to a warning when no token is configured', () => {
    const { worker, handlers, logger } = setup(null);

    worker.onApplicationBootstrap();

    expect(handlers.register).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    // Shutdown must stay harmless when nothing was ever started.
    expect(() => worker.onApplicationShutdown()).not.toThrow();
  });

  it('stops polling on shutdown', () => {
    const stopPolling = jest.fn();
    const { worker } = setup({
      start: jest.fn().mockReturnValue(new Promise(() => {})),
      stopPolling,
    });

    worker.onApplicationBootstrap();
    worker.onApplicationShutdown();

    expect(stopPolling).toHaveBeenCalled();
  });

  it('does not stop polling it never started', () => {
    const stopPolling = jest.fn();
    const { worker } = setup({ stopPolling });

    worker.onApplicationShutdown();

    expect(stopPolling).not.toHaveBeenCalled();
  });
});
