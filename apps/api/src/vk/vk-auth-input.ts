/**
 * Разбор того, что админ вставляет в панель после авторизации в VK.
 *
 * Адрес возврата у нашего приложения один-единственный —
 * `https://oauth.vk.com/blank.html` (VK не принимает другого), поэтому после
 * разрешения доступа браузер остаётся на пустой странице VK и до нашего
 * сервера не доходит. Код лежит в адресной строке этой страницы, и его
 * приходится передавать вручную: человек копирует адрес и вставляет его в
 * панель.
 *
 * Принимается всё, что человек может скопировать: адрес целиком (код в
 * запросе или после `#`), кусок вида `code=…&state=…` или один голый код.
 * Отдельно распознаётся отказ VK — иначе на «я нажал “Запретить”» панель
 * отвечала бы «не нашёл код», и человек не понял бы, что дело не в нём.
 */
export type VkAuthInput =
  | { kind: 'code'; code: string; state: string | null }
  | { kind: 'denied'; description: string };

/** Разумные границы: короче — явно не код, длиннее — не то, что скопировали. */
const CODE_MIN = 10;
const CODE_MAX = 512;

function param(text: string, name: string): string | null {
  const match = new RegExp(`(?:^|[?&#\\s])${name}=([^&#\\s]+)`).exec(text);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' '));
  } catch {
    // Битая процентная запись — берём как есть: лучше передать VK то, что
    // человек скопировал, и получить внятный отказ от него.
    return match[1];
  }
}

export function parseVkAuthInput(raw: string): VkAuthInput | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }

  // Отказ проверяется раньше кода: VK на «Запретить» кода не даёт, но если в
  // тексте вперемешку оказались обрывки двух попыток (например, вставили
  // старую и новую авторизацию вместе), отказ важнее — молчать о нём нельзя.
  if (param(text, 'error')) {
    return {
      kind: 'denied',
      description:
        param(text, 'error_description') ?? param(text, 'error') ?? 'отказ',
    };
  }

  const code = param(text, 'code');
  if (code) {
    return code.length >= CODE_MIN && code.length <= CODE_MAX
      ? { kind: 'code', code, state: param(text, 'state') }
      : null;
  }

  // Голый код: только символы, которые бывают в коде авторизации.
  if (
    text.length >= CODE_MIN &&
    text.length <= CODE_MAX &&
    /^[A-Za-z0-9_.-]+$/.test(text)
  ) {
    return { kind: 'code', code: text, state: null };
  }
  return null;
}
