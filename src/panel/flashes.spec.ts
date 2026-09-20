import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLASHES } from './panel.controller';

/**
 * Сообщение, на которое не заведена запись, `shell` отфильтровывает — и
 * страница перерисовывается молча. Отказ становится неотличим от успеха, а
 * заметить это можно только глазами, потому что редирект-то происходит.
 *
 * Поэтому список сверяется с кодом автоматически: ровно так три ключа
 * однажды и потерялись при правке.
 */
describe('FLASHES', () => {
  const source = readFileSync(join(__dirname, 'panel.controller.ts'), 'utf8');
  // Комментарии вырезаются: в них разбираются примеры вроде
  // `?flash=constructor`, и без этого тест ловил бы пояснения, а не код.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const used = [...code.matchAll(/flash=([a-z-]+)/g)].map((m) => m[1]);

  it('находит использования в коде', () => {
    expect(used.length).toBeGreaterThan(5);
  });

  it('has an entry for every flash the controller redirects with', () => {
    const missing = used.filter((key) => !Object.hasOwn(FLASHES, key));

    expect(missing).toEqual([]);
  });

  it('gives every entry a kind and a message', () => {
    for (const [key, value] of Object.entries(FLASHES)) {
      expect(value.kind).toBeTruthy();
      expect(value.message).toBeTruthy();
      expect(key).not.toContain(' ');
    }
  });
});
