import { headerSafeFileName } from './header-safe-filename';

describe('headerSafeFileName', () => {
  it.each([
    [
      'Запись экрана от 2025-08-01 11-45-58.webm',
      'Zapis ekrana ot 2025-08-01 11-45-58.webm',
    ],
    ['Щука и ёж.mp4', 'Schuka i ezh.mp4'],
    ['clip "final".mov', 'clip _final_.mov'],
    ['видео😀.mp4', 'video_.mp4'],
    ['already-ascii.webm', 'already-ascii.webm'],
    ['😀', '_'],
    ['', 'file'],
  ])('%s → %s', (input, expected) => {
    expect(headerSafeFileName(input)).toBe(expected);
  });

  it('never yields a character Node would refuse in a header', () => {
    expect(headerSafeFileName('Ωmega — «тест» ✓.webm')).toMatch(
      /^[\x20-\x7e]+$/,
    );
  });
});
