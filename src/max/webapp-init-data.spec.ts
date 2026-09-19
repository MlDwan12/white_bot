import {
  extractWebAppData,
  signInitData,
  validateInitData,
} from './webapp-init-data';

const TOKEN = 'test-bot-token';
const NOW_S = 1771409719;
const now = () => NOW_S * 1000;

const params = (overrides: Record<string, string> = {}) => ({
  auth_date: String(NOW_S),
  chat: '{"id":12345,"type":"DIALOG"}',
  ip: '192.168.0.1',
  query_id: '4c0ab423-342b-4e45-aea4-2747dbc500cd',
  user: '{"id":67890,"first_name":"Max","last_name":"User","username":null}',
  ...overrides,
});

describe('validateInitData', () => {
  it('accepts data signed with the bot token', () => {
    const raw = signInitData(params(), TOKEN);

    const result = validateInitData(raw, TOKEN, { now });

    expect(result).toMatchObject({ valid: true });
    if (result.valid) {
      expect(result.data.user?.id).toBe(67890);
      expect(result.data.chat?.type).toBe('DIALOG');
      expect(result.data.auth_date).toBe(NOW_S);
    }
  });

  it('rejects data signed with a different token', () => {
    // The whole point: a page can claim to be any user, and only the
    // signature separates a real launch from a forged one.
    const raw = signInitData(params(), 'someone-elses-token');

    expect(validateInitData(raw, TOKEN, { now })).toEqual({
      valid: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('rejects a tampered field even though the hash is untouched', () => {
    const raw = signInitData(params(), TOKEN).replace('67890', '11111');

    expect(validateInitData(raw, TOKEN, { now })).toEqual({
      valid: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('rejects a second hash smuggled in', () => {
    // Otherwise an attacker could append their own hash and hope the
    // implementation picks that one while signing the original params.
    const raw = `${signInitData(params(), TOKEN)}&hash=deadbeef`;

    expect(validateInitData(raw, TOKEN, { now })).toEqual({
      valid: false,
      reason: 'DUPLICATE_HASH',
    });
  });

  it('rejects data with no hash at all', () => {
    expect(validateInitData('user=%7B%7D&auth_date=1', TOKEN, { now })).toEqual(
      {
        valid: false,
        reason: 'NO_HASH',
      },
    );
  });

  it('rejects an empty string', () => {
    expect(validateInitData('', TOKEN)).toEqual({
      valid: false,
      reason: 'EMPTY',
    });
  });

  it('rejects launch data older than the allowed age', () => {
    const raw = signInitData(params(), TOKEN);

    // A signature never expires on its own, so an intercepted initData would
    // otherwise work forever as a login.
    expect(
      validateInitData(raw, TOKEN, {
        now: () => (NOW_S + 48 * 60 * 60) * 1000,
      }),
    ).toEqual({ valid: false, reason: 'EXPIRED' });
  });

  it('can be told not to check the age at all', () => {
    const raw = signInitData(params(), TOKEN);

    expect(
      validateInitData(raw, TOKEN, {
        maxAgeSeconds: 0,
        now: () => (NOW_S + 48 * 60 * 60) * 1000,
      }),
    ).toMatchObject({ valid: true });
  });

  it('carries the deep-link payload through', () => {
    // This is how a contest id reaches the mini app:
    // https://max.ru/<bot>?startapp=<contestId>
    const contestId = '11111111-1111-4111-8111-111111111111';
    const raw = signInitData(params({ start_param: contestId }), TOKEN);

    const result = validateInitData(raw, TOKEN, { now });

    expect(result.valid && result.data.start_param).toBe(contestId);
  });

  it('handles a value containing an equals sign', () => {
    // MAX's own example splits on every '=', which would mangle such a
    // value; signing and checking must agree on where the key ends.
    const raw = signInitData(params({ start_param: 'a=b' }), TOKEN);

    expect(validateInitData(raw, TOKEN, { now })).toMatchObject({
      valid: true,
      data: { start_param: 'a=b' },
    });
  });

  it('does not depend on the order the parameters arrive in', () => {
    const raw = signInitData(params(), TOKEN);
    const parts = raw.split('&');
    const reordered = [...parts.slice(1), parts[0]].join('&');

    expect(validateInitData(reordered, TOKEN, { now })).toMatchObject({
      valid: true,
    });
  });
});

describe('extractWebAppData', () => {
  it('reads the signed blob out of the URL fragment', () => {
    const url =
      'https://example.com/app#WebAppData=user%3D%257B%257D%26hash%3Dabc&WebAppPlatform=web&WebAppVersion=26.2.8';

    expect(extractWebAppData(url)).toBe('user=%7B%7D&hash=abc');
  });

  it('returns null when the page was opened without launch data', () => {
    expect(extractWebAppData('https://example.com/app')).toBeNull();
  });
});
