import { sanitizeUrl } from './sanitize-url';

describe('sanitizeUrl', () => {
  it('leaves a URL with no query string untouched', () => {
    expect(sanitizeUrl('/health')).toBe('/health');
  });

  it('redacts access_token', () => {
    expect(sanitizeUrl('/health?access_token=SECRET123')).toBe(
      '/health?access_token=%5BREDACTED%5D',
    );
  });

  it('redacts token and password alongside untouched params', () => {
    const result = sanitizeUrl('/x?token=abc&password=hunter2&page=2');
    expect(result).toContain('token=%5BREDACTED%5D');
    expect(result).toContain('password=%5BREDACTED%5D');
    expect(result).toContain('page=2');
  });

  it('does not touch unrelated query params', () => {
    expect(sanitizeUrl('/x?foo=bar')).toBe('/x?foo=bar');
  });

  it('does not truncate a query string containing a literal ? in a value', () => {
    const url = '/x?redirect_uri=http://example.com?foo=bar&page=2';
    const result = sanitizeUrl(url);
    // nothing after the first '?' is silently dropped
    expect(result).toContain('page=2');
    expect(decodeURIComponent(result)).toContain(
      'redirect_uri=http://example.com?foo=bar',
    );
  });
});
