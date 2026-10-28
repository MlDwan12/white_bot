import type { ContestKeyboardButton } from '../contests/contest-button';

/**
 * Экран согласия на обработку персональных данных перед первым действием
 * бота — требование самой платформы MAX и 152-ФЗ: бот обрабатывает данные
 * человека (сохраняет профиль, участие в конкурсе), и делать это без
 * явного согласия нельзя.
 *
 * Единый для обоих входов в бота — старта по ссылке конкурса и обычного
 * «Начать» через поиск: оба идут через событие `bot_started`
 * (`MaxBotHandlers.handleBotStarted`), и без этого файла проверка
 * согласия легко разошлась бы между ними.
 */

/**
 * Полезная нагрузка кнопки «Продолжить»: `consent:<то, ради чего человек
 * пришёл>`. Исходный payload `bot_started` (пустой при обычном старте,
 * `c_<uuid>` при переходе по ссылке конкурса) едет внутри — так после
 * согласия можно сразу продолжить то самое действие, не храня «отложенное
 * намерение» отдельно.
 */
export const CONSENT_ACCEPT_PAYLOAD = /^consent:(.*)$/;

export function consentAcceptPayload(resumePayload: string): string {
  return `consent:${resumePayload}`;
}

/**
 * Публичные страницы-заглушки в docs/ (GitHub Pages, `master`/docs — тот
 * же способ публикации, что и у зонда мини-аппа). Текста там пока нет,
 * только адрес: см. `docs/privacy.html` и `docs/personal-data.html`.
 */
const PRIVACY_POLICY_URL = 'https://mldwan12.github.io/white_bot/privacy.html';
const PERSONAL_DATA_POLICY_URL =
  'https://mldwan12.github.io/white_bot/personal-data.html';

export const CONSENT_TEXT =
  'Добро пожаловать!\n\n' +
  'Для использования бота необходимо ознакомиться с документами и дать ' +
  'согласие на обработку персональных данных.\n\n' +
  'Нажимая «Продолжить», вы подтверждаете, что ознакомились с документами ' +
  'и даёте согласие на обработку персональных данных.';

/** Две ссылки на документы и кнопка «Продолжить», несущая исходное намерение. */
export function consentKeyboard(
  resumePayload: string,
): ContestKeyboardButton[][] {
  return [
    [
      {
        type: 'link',
        text: 'Политика конфиденциальности',
        url: PRIVACY_POLICY_URL,
      },
    ],
    [
      {
        type: 'link',
        text: 'Обработка персональных данных',
        url: PERSONAL_DATA_POLICY_URL,
      },
    ],
    [
      {
        type: 'callback',
        text: '✅ Продолжить',
        payload: consentAcceptPayload(resumePayload),
      },
    ],
  ];
}
