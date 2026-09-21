import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLASHES, FLASH_ACTIONS } from './panel.controller';

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
  // Два способа редиректить с флэшем в этом файле: собрать адрес прямо на
  // месте (`?flash=sent`) или отдать через общий `redirectFlash(res, page,
  // 'kind', ...)` — второй параметр вида, третий (после страницы) — литерал.
  // Страница — литерал в кавычках (`'groups'`) либо шаблонная строка с
  // подстановкой (`` `campaigns/${id}` ``), поэтому кавычка вокруг неё не
  // фиксируется определённым символом.
  const used = [
    ...[...code.matchAll(/flash=([a-z-]+)/g)].map((m) => m[1]),
    ...[
      ...code.matchAll(
        /redirectFlash\(\s*res,\s*[`'][^`']*[`'],\s*'([a-z-]+)'/g,
      ),
    ].map((m) => m[1]),
  ];

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

describe('FLASH_ACTIONS', () => {
  const source = readFileSync(join(__dirname, 'panel.controller.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('каждое действие, которым редиректит контроллер, есть в белом списке', () => {
    // `?action=` приходит из адреса, и в баннер попадает только то, что
    // заведено здесь, — но и обратное важно: ключ без записи дал бы баннер
    // без кнопки, а отказ выглядел бы тупиком. Значение либо литерал прямо в
    // адресе, либо результат `const action = … ? 'kind' : undefined`,
    // который потом уходит в `redirectFlash`.
    const used = [
      ...[...code.matchAll(/action=([a-z-]+)/g)].map((m) => m[1]),
      ...[...code.matchAll(/\baction\s*=[\s\S]{0,120}?\?\s*'([a-z-]+)'/g)].map(
        (m) => m[1],
      ),
    ];
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((key) => !Object.hasOwn(FLASH_ACTIONS, key))).toEqual(
      [],
    );
  });

  it('у каждого действия есть подпись, внутренняя ссылка и право', () => {
    for (const action of Object.values(FLASH_ACTIONS)) {
      expect(action.label).toBeTruthy();
      // Только путь внутри панели: произвольный адрес в кнопку попасть не
      // должен даже по ошибке.
      expect(action.href.startsWith('/')).toBe(true);
      expect(action.permission).toBeTruthy();
    }
  });
});
