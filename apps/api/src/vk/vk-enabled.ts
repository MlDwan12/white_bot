import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';

/**
 * Выключатель VK целиком (решение пользователя 28.10.2026: «пока VK никак не
 * взаимодействовать»). Пока `VK_ENABLED` не `true`, бот не делает ни одного
 * запроса в VK, а панель не показывает VK никому, включая developer.
 *
 * `process.env`, а не `ConfigService`: проверка нужна в местах без DI-контекста
 * под рукой и в тестах, а значение читается одно — так же, как
 * `DEFAULT_TIMEZONE` в `format-date.ts`.
 */
export function vkEnabled(): boolean {
  return process.env.VK_ENABLED === 'true';
}

/**
 * Последний рубеж перед сетью. Доставка VK, оставшаяся с прежних времён
 * (повторяющийся шаблон с VK-целью), падает здесь окончательно, без
 * повторов: это не `VkApiError`, и `classifyDeliveryError` считает её
 * ошибкой нашего кода.
 */
export function assertVkEnabled(): void {
  if (!vkEnabled()) {
    throw new AppException(
      ErrorCode.REQUEST_ERROR,
      'VK выключен (VK_ENABLED=false)',
    );
  }
}
