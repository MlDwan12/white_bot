import {
  CONTEST_START_PAYLOAD,
  contestDmUrl,
  contestKeyboard,
  contestStartPayload,
} from './contest-button';

const ID = '11111111-1111-4111-8111-111111111111';

describe('contestKeyboard', () => {
  it('со ссылкой на бота даёт одну кнопку-ссылку с подписью участия', () => {
    // Кнопка одна: это и участие, и вход в диалог с ботом. Две кнопки
    // смотрелись громоздко, а диалог так открывается у каждого участника.
    expect(
      contestKeyboard(
        { text: 'Участвовать (3)', payload: 'contest:join:x' },
        'https://max.ru/test_bot?start=c_x',
      ),
    ).toEqual([
      [
        {
          type: 'link',
          text: 'Участвовать (3)',
          url: 'https://max.ru/test_bot?start=c_x',
        },
      ],
    ]);
  });

  it('без имени бота остаётся прежняя кнопка с колбэком', () => {
    // Имя известно не сразу после старта. Колбэк по-прежнему записывает
    // участие — просто без личного диалога, — и он же обслуживает посты,
    // вышедшие до перехода на ссылку.
    expect(
      contestKeyboard({ text: 'Участвовать', payload: 'p' }, null),
    ).toEqual([[{ type: 'callback', text: 'Участвовать', payload: 'p' }]]);
  });
});

describe('contestDmUrl', () => {
  it('собирает ссылку на диалог с меткой конкурса', () => {
    expect(contestDmUrl('id2311395309_bot', ID)).toBe(
      `https://max.ru/id2311395309_bot?start=c_${ID}`,
    );
  });

  it('без имени бота ссылки нет', () => {
    expect(contestDmUrl(null, ID)).toBeNull();
    expect(contestDmUrl(undefined, ID)).toBeNull();
    expect(contestDmUrl('', ID)).toBeNull();
  });
});

describe('метка запуска бота', () => {
  it('собранная метка разбирается обратно в id конкурса', () => {
    expect(CONTEST_START_PAYLOAD.exec(contestStartPayload(ID))?.[1]).toBe(ID);
  });

  it('чужая или битая метка не совпадает', () => {
    // Иначе любой посторонний старт с произвольной строкой запускал бы ответ
    // про конкурс.
    for (const payload of ['', 'c_', 'c_not-a-uuid', `x_${ID}`, `c_${ID}zzz`]) {
      expect(CONTEST_START_PAYLOAD.exec(payload)).toBeNull();
    }
  });
});
