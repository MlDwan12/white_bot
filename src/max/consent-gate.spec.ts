import {
  CONSENT_ACCEPT_PAYLOAD,
  consentAcceptPayload,
  consentKeyboard,
} from './consent-gate';

describe('consentAcceptPayload / CONSENT_ACCEPT_PAYLOAD', () => {
  it('несёт исходное намерение внутри и разбирается обратно', () => {
    expect(CONSENT_ACCEPT_PAYLOAD.exec(consentAcceptPayload('c_x'))?.[1]).toBe(
      'c_x',
    );
  });

  it('пустое исходное намерение (обычный старт без метки) тоже едет и разбирается', () => {
    expect(CONSENT_ACCEPT_PAYLOAD.exec(consentAcceptPayload(''))?.[1]).toBe('');
  });

  it('не совпадает с посторонней строкой', () => {
    expect(CONSENT_ACCEPT_PAYLOAD.exec('contest:join:x')).toBeNull();
  });
});

describe('consentKeyboard', () => {
  it('две ссылки на документы и колбэк «Продолжить» с исходным намерением внутри', () => {
    const buttons = consentKeyboard('c_x');

    expect(buttons).toHaveLength(3);
    expect(buttons[0][0]).toMatchObject({ type: 'link' });
    expect(buttons[1][0]).toMatchObject({ type: 'link' });
    expect(buttons[2][0]).toEqual({
      type: 'callback',
      text: '✅ Продолжить',
      payload: 'consent:c_x',
    });
  });

  it('ссылки на документы ведут на HTTPS-страницы, а не куда попало', () => {
    // Кнопка-ссылка — единственное, что видит человек до согласия: если бы
    // адрес собирался неправильно (например, пустая строка), MAX отдал бы
    // нерабочую кнопку без всякого объяснения.
    for (const row of consentKeyboard('')) {
      const button = row[0];
      if (button.type === 'link') {
        expect(button.url.startsWith('https://')).toBe(true);
      }
    }
  });
});
