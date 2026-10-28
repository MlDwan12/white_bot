-- Текст поста теперь HTML-подмножество MAX (см. src/common/post-html.ts).
-- Прежние тексты — обычные: экранируем спецсимволы, иначе «a < b» или
-- «Q&A» сломали бы сообщение при отправке с format: 'html'.
-- Сначала &, чтобы не задеть добавленные ниже сущности.
UPDATE "Post" SET
  "text" = replace(replace(replace("text", '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
  "vkTextOverride" = replace(replace(replace("vkTextOverride", '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
  "maxTextOverride" = replace(replace(replace("maxTextOverride", '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
WHERE "text" ~ '[&<>]' OR "vkTextOverride" ~ '[&<>]' OR "maxTextOverride" ~ '[&<>]';
