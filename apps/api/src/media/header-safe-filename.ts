const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/**
 * Имя файла, пригодное для HTTP-заголовка. Видео SDK MAX грузит частями и
 * кладёт имя сырым в `Content-Disposition` и `X-File-Name`, а Node не
 * пускает в заголовок ничего вне latin1 — «Запись экрана … .webm» падала с
 * «Invalid character in header content» (прод, 23.09.2026). Картинки и
 * документы идут multipart-телом, где кириллица допустима, и им это не нужно.
 *
 * Кириллица транслитерируется (имя остаётся узнаваемым), всё прочее вне
 * печатного ASCII и кавычки — в `_`, расширение сохраняется.
 */
export function headerSafeFileName(name: string): string {
  const transliterated = [...name]
    .map((ch) => {
      const lower = ch.toLowerCase();
      const latin = CYRILLIC[lower];
      if (latin === undefined) return ch;
      return ch === lower
        ? latin
        : latin.charAt(0).toUpperCase() + latin.slice(1);
    })
    .join('');
  const safe = transliterated.replace(/[^\x20-\x7e]|["\\]/gu, '_').trim();
  return safe || 'file';
}
