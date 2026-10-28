import { escapeHtml, postHtmlToPlain } from './post-html';

describe('postHtmlToPlain', () => {
  it('снимает теги и раскрывает сущности, переносы оставляет', () => {
    expect(postHtmlToPlain('<b>Q&amp;A</b>\n<i>a &lt; b</i>')).toBe(
      'Q&A\na < b',
    );
  });

  it('дописывает адрес ссылки, если подпись — не он сам', () => {
    expect(postHtmlToPlain('<a href="https://x.ru/?a=1&amp;b=2">тут</a>')).toBe(
      'тут (https://x.ru/?a=1&b=2)',
    );
    expect(postHtmlToPlain('<a href="https://x.ru">https://x.ru</a>')).toBe(
      'https://x.ru',
    );
  });

  it('экранированный текст возвращается к исходному', () => {
    const raw = `<a href="x">'&amp;"`;
    expect(postHtmlToPlain(escapeHtml(raw))).toBe(raw);
  });
});
