import { createTimeoutFetch, timeoutForUrl } from './max-bot.provider';

const BASE = 'https://platform-api2.max.ru';

function captureFetch() {
  const calls: RequestInit[] = [];
  const baseFetch = jest.fn((_input: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    return Promise.resolve(new Response('{}'));
  }) as unknown as typeof fetch;
  return { baseFetch, calls };
}

describe('createTimeoutFetch', () => {
  it('attaches a timeout signal to a regular API call', async () => {
    const { baseFetch, calls } = captureFetch();
    await createTimeoutFetch(baseFetch)(`${BASE}/messages`, { method: 'POST' });

    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].signal?.aborted).toBe(false);
  });

  it('keeps the caller signal alive, so polling can still be stopped', async () => {
    const { baseFetch, calls } = captureFetch();
    const controller = new AbortController();

    await createTimeoutFetch(baseFetch)(`${BASE}/updates`, {
      signal: controller.signal,
    });
    // Without combining the two signals the SDK's shutdown abort would be
    // dropped and polling could never be stopped.
    expect(calls[0].signal?.aborted).toBe(false);
    controller.abort();
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it('gives /updates a longer deadline than a regular call', () => {
    // Asserted on the chosen budget rather than by advancing timers:
    // AbortSignal.timeout runs on a native timer that jest's fake timers
    // don't patch, so a timing-based test here would silently never fire.
    expect(timeoutForUrl(`${BASE}/updates`)).toBeGreaterThan(
      timeoutForUrl(`${BASE}/messages`),
    );
    // A long poll must outlast MAX's own ~30s polling window, or every idle
    // poll would be cut short by our own deadline.
    expect(timeoutForUrl(`${BASE}/updates`)).toBeGreaterThan(30_000);
  });

  it('does not mistake a path merely containing "updates" for the polling endpoint', () => {
    expect(timeoutForUrl(`${BASE}/updates/subscriptions`)).toBe(
      timeoutForUrl(`${BASE}/messages`),
    );
  });
});
