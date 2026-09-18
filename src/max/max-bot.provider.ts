import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from '@maxhub/max-bot-api';

export const MAX_BOT = Symbol('MAX_BOT');

/** Normal API calls: same budget as VkApiClient's REQUEST_TIMEOUT_MS. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Long polling holds the connection open until an update arrives, so the
 * regular timeout would kill every idle poll. This is only a stuck-socket
 * safety net well above MAX's own ~30s polling window — the SDK reconnects
 * on abort, so a false trip costs one extra round trip, not lost updates.
 */
const UPDATES_TIMEOUT_MS = 90_000;

/**
 * The SDK's HTTP client applies no timeout of its own — it only forwards a
 * caller-provided `signal` (which its polling loop uses for shutdown). A hung
 * connection would therefore hang the call forever, so we wrap `fetch` to add
 * our own deadline while preserving whatever signal the SDK passed in.
 */
export function timeoutForUrl(url: string): number {
  return new URL(url).pathname.endsWith('/updates')
    ? UPDATES_TIMEOUT_MS
    : REQUEST_TIMEOUT_MS;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function createTimeoutFetch(
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input: FetchInput, init?: FetchInit) => {
    const timeout = AbortSignal.timeout(timeoutForUrl(urlOf(input)));
    // The SDK's polling loop passes its shutdown signal here; dropping it
    // would leave polling unable to stop, so both signals must stay live.
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    return baseFetch(input, { ...init, signal });
  };
}

/**
 * Resolves to `null` when MAX_BOT_TOKEN isn't configured, so the app still
 * boots without MAX credentials (local runs, CI, e2e). Every consumer must
 * handle the null — MaxApiClient turns it into a domain error, the polling
 * worker into a startup warning.
 */
export const maxBotProvider: Provider = {
  provide: MAX_BOT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Bot | null => {
    const token = config.get<string>('MAX_BOT_TOKEN');
    if (!token) {
      return null;
    }
    return new Bot(token, {
      clientOptions: { fetch: createTimeoutFetch() },
    });
  },
};
