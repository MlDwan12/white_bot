import { useEffect, useRef } from 'react';
import { ActionIcon, Group, Input, Paper } from '@mantine/core';
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import './RichText.css';

/**
 * Текст поста хранится так, как его принимает MAX с `format: 'html'`
 * (см. `src/common/post-html.ts` на сервере): строчные теги, абзацы — `\n`.
 * Поэтому из возможностей Tiptap оставлено только то, что MAX умеет показать:
 * заголовков, списков и цитат в его HTML нет.
 */
const extensions = [
  StarterKit.configure({
    heading: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    listKeymap: false,
    blockquote: false,
    codeBlock: false,
    horizontalRule: false,
    link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
  }),
];

const TAGS: Record<string, string> = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
  strike: 's',
  code: 'code',
};

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(node: JSONContent): string {
  if (node.type === 'hardBreak') return '\n';
  let html = esc(node.text ?? '');
  for (const mark of node.marks ?? []) {
    if (mark.type === 'link') html = `<a href="${esc(String(mark.attrs?.href ?? ''))}">${html}</a>`;
    else if (TAGS[mark.type]) html = `<${TAGS[mark.type]}>${html}</${TAGS[mark.type]}>`;
  }
  return html;
}

function toPostHtml(doc: JSONContent): string {
  return (doc.content ?? []).map((p) => (p.content ?? []).map(inline).join('')).join('\n');
}

function fromPostHtml(html: string): string {
  return html
    .split('\n')
    .map((line) => `<p>${line}</p>`)
    .join('');
}

/** Первая непустая строка текста поста, без разметки, — для превью в списках. */
export function postFirstLine(html: string): string {
  const plain = new DOMParser().parseFromString(fromPostHtml(html), 'text/html').body;
  return [...plain.children].map((p) => p.textContent ?? '').find((l) => l.trim()) ?? 'Без текста';
}

export function RichText({
  label,
  description,
  minRows = 3,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  minRows?: number;
  value: string;
  onChange: (html: string) => void;
}) {
  // Что редактор отдал последним: внешнее значение подставляется заново,
  // только если пришло что-то другое (загрузили черновик), — иначе каждое
  // нажатие сбрасывало бы курсор в начало.
  const emitted = useRef(value);
  const editor = useEditor({
    extensions,
    content: fromPostHtml(value),
    onUpdate: ({ editor }) => {
      emitted.current = toPostHtml(editor.getJSON());
      onChange(emitted.current);
    },
  });

  useEffect(() => {
    if (editor && value !== emitted.current) {
      emitted.current = value;
      editor.commands.setContent(fromPostHtml(value), { emitUpdate: false });
    }
  }, [editor, value]);

  return (
    <Input.Wrapper label={label} description={description}>
      <Paper withBorder radius="sm" mt={4}>
        {editor && <Toolbar editor={editor} />}
        <EditorContent
          editor={editor}
          style={{
            padding: '6px 12px',
            minHeight: `${minRows * 1.55 + 0.75}em`,
          }}
          className="rich-text"
        />
      </Paper>
    </Input.Wrapper>
  );
}

/** Только чтение — показать текст поста с разметкой в карточке. */
export function RichView({ value }: { value: string }) {
  const editor = useEditor({ extensions, content: fromPostHtml(value), editable: false }, [value]);
  return <EditorContent editor={editor} className="rich-text" />;
}

const BUTTONS = [
  {
    mark: 'bold',
    label: 'Ж',
    title: 'Жирный (Ctrl+B)',
    style: { fontWeight: 700 },
  },
  {
    mark: 'italic',
    label: 'К',
    title: 'Курсив (Ctrl+I)',
    style: { fontStyle: 'italic' },
  },
  {
    mark: 'underline',
    label: 'Ч',
    title: 'Подчёркнутый (Ctrl+U)',
    style: { textDecoration: 'underline' },
  },
  {
    mark: 'strike',
    label: 'З',
    title: 'Зачёркнутый',
    style: { textDecoration: 'line-through' },
  },
] as const;

function Toolbar({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor }) =>
      Object.fromEntries([...BUTTONS.map((b) => b.mark), 'link'].map((m) => [m, editor.isActive(m)])),
  });

  const link = () => {
    if (active.link) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const href = window.prompt('Адрес ссылки', 'https://')?.trim();
    if (!href || href === 'https://') return;
    // insertContent ниже минует проверку адреса из расширения Link.
    if (!/^https?:\/\/\S+$/i.test(href)) {
      window.alert('Адрес должен начинаться с http:// или https://');
      return;
    }
    const chain = editor.chain().focus();
    // Без выделения вставляем сам адрес, иначе ссылке не на чем повиснуть.
    (editor.state.selection.empty
      ? chain.insertContent({
          type: 'text',
          text: href,
          marks: [{ type: 'link', attrs: { href } }],
        })
      : chain.setLink({ href })
    ).run();
  };

  return (
    <Group gap={4} p={4} style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
      {BUTTONS.map((b) => (
        <ActionIcon
          key={b.mark}
          variant={active[b.mark] ? 'filled' : 'subtle'}
          color="gray"
          title={b.title}
          aria-label={b.title}
          onClick={() => editor.chain().focus().toggleMark(b.mark).run()}
        >
          <span style={b.style}>{b.label}</span>
        </ActionIcon>
      ))}
      <ActionIcon
        variant={active.link ? 'filled' : 'subtle'}
        color="gray"
        title={active.link ? 'Убрать ссылку' : 'Ссылка'}
        aria-label={active.link ? 'Убрать ссылку' : 'Ссылка'}
        onClick={link}
      >
        🔗
      </ActionIcon>
    </Group>
  );
}
