import { fmt } from '@maxhub/max-bot-api';

/**
 * Текст поста хранится так, как его принимает MAX с `format: 'html'`:
 * строчные теги (`<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<a href>`), переносы —
 * обычные `\n`, спецсимволы экранированы. Собирает его редактор панели.
 * VK, мини-апп и журнал разметку не понимают — им нужен текст без неё.
 */
export function postHtmlToPlain(html: string): string {
  return decodeEntities(
    html
      // Ссылка с подписью теряла бы адрес — дописываем его в скобках.
      .replace(
        /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
        (_, href: string, label: string) => {
          const url = decodeEntities(href);
          const text = label.replace(/<[^>]*>/g, '');
          return decodeEntities(text) === url ? text : `${text} (${href})`;
        },
      )
      .replace(/<[^>]*>/g, ''),
  );
}

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&',
};

function decodeEntities(text: string): string {
  return text.replace(/&(lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity]);
}

/** Пользовательский текст (имена, названия) для вставки в текст поста. */
export const escapeHtml = fmt.escapeHtml;
