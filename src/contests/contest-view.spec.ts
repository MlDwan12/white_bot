import { shortenName } from './contest-view';

describe('shortenName', () => {
  it('keeps the first name and shortens the surname', () => {
    expect(shortenName('Иван Петренко', 'Иван', 'Петренко')).toBe('Иван П.');
  });

  it('shows just the first name when there is no surname', () => {
    expect(shortenName('Иван', 'Иван', null)).toBe('Иван');
  });

  it('falls back to splitting the display name', () => {
    // Участник, добавленный админом руками, приходит без разобранных полей —
    // о нём известно только то, что написали в строке.
    expect(shortenName('Мария Сидорова')).toBe('Мария С.');
  });

  it('leaves a single-word display name alone', () => {
    expect(shortenName('Аноним')).toBe('Аноним');
  });

  it('ignores extra spacing in a display name', () => {
    expect(shortenName('  Пётр   Васильев  ')).toBe('Пётр В.');
  });

  it('does not split a surrogate pair in half', () => {
    // Взять первый code unit у имени вне BMP — значит отдать половину
    // суррогатной пары и получить «сломанный» символ на экране.
    expect(shortenName('Иван 𝒮мирнов', 'Иван', '𝒮мирнов')).toBe('Иван 𝒮.');
  });

  it('never returns an empty label', () => {
    // Пустое имя оставило бы в списке победителей пустую строку — выглядит
    // как сбой, а не как участник.
    expect(shortenName('   ')).toBe('Участник');
  });

  it('prefers the parsed fields over the display name', () => {
    expect(shortenName('что-то другое', 'Анна', 'Смирнова')).toBe('Анна С.');
  });
});
