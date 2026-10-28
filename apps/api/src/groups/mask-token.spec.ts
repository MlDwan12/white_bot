import { maskToken } from './mask-token';

describe('maskToken', () => {
  it('keeps the first and last 4 characters of a long token', () => {
    expect(maskToken('vk1a1234567890ab12')).toBe('vk1a****ab12');
  });

  it('fully masks a short token instead of leaking its length as data', () => {
    expect(maskToken('short')).toBe('****');
  });
});
