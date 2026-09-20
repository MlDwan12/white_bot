import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ContestNotifyStatus,
  ContestStatus,
  GroupStatus,
  PostDeliveryStatus,
  PostStatus,
} from '../generated/prisma/client';
import {
  contestColor,
  deliveryColor,
  groupColor,
  notifyColor,
  platformColor,
  statusColor,
  templateColor,
} from './view-helpers';

/**
 * Метки в панели красятся классами `tag-<цвет>` из `layout.ejs`, а цвет
 * приходит из помощников. Стоит помощнику вернуть цвет, которого нет в
 * палитре, — метка рисуется без стиля, и статус превращается в пустое пятно.
 * Именно так метки и стали нечитаемыми: цвет был, а текст его не получал.
 *
 * Поэтому палитра сверяется с кодом автоматически, а не глазами.
 */
const layout = readFileSync(join(__dirname, 'views', 'layout.ejs'), 'utf8');

function paletteOf(prefix: 'tag' | 'tone') {
  const pairs = new Map<string, { bg?: string; text: string }>();
  const rule = new RegExp(`\\.${prefix}-([a-z]+)\\s*\\{([^}]*)\\}`, 'g');
  for (const m of layout.matchAll(rule)) {
    const bg = /background:\s*(#[0-9a-f]{6})/i.exec(m[2])?.[1];
    const text = /(?<![-\w])color:\s*(#[0-9a-f]{6})/i.exec(m[2])?.[1];
    if (text) {
      pairs.set(m[1], { bg, text });
    }
  }
  return pairs;
}

const tags = paletteOf('tag');
const tones = paletteOf('tone');

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('палитра меток панели', () => {
  it('находит палитру в layout.ejs', () => {
    expect(tags.size).toBeGreaterThanOrEqual(9);
    expect(tones.size).toBeGreaterThanOrEqual(9);
  });

  it('каждая пара «фон/текст» читаема: контраст не ниже 4,5:1 (WCAG AA)', () => {
    for (const [name, { bg, text }] of tags) {
      expect(bg).toBeDefined();
      expect({ name, ratio: contrast(bg!, text) >= 4.5 }).toEqual({
        name,
        ratio: true,
      });
    }
  });

  it('цветной текст без фона читаем на белом', () => {
    for (const [name, { text }] of tones) {
      expect({ name, ok: contrast('#ffffff', text) >= 4.5 }).toEqual({
        name,
        ok: true,
      });
    }
  });

  it('у каждого цвета, который могут вернуть помощники, есть стиль метки', () => {
    const used = new Set<string>();
    const delivery = (status: PostDeliveryStatus, deleted = false) => ({
      status,
      deletedAt: deleted ? new Date() : null,
      autoDeleteDueAt: null,
    });

    for (const s of Object.values(PostStatus)) used.add(statusColor(s));
    for (const s of Object.values(PostDeliveryStatus)) {
      used.add(deliveryColor(delivery(s)));
    }
    used.add(deliveryColor(delivery('sent', true)));
    for (const s of Object.values(GroupStatus)) used.add(groupColor(s));
    for (const s of Object.values(ContestStatus)) used.add(contestColor(s));
    for (const s of Object.values(ContestNotifyStatus)) {
      used.add(notifyColor(s));
    }
    for (const s of ['running', 'paused', 'disarmed', 'no_targets'] as const) {
      used.add(templateColor(s));
    }
    for (const p of ['vk', 'max', 'что-то-новое']) used.add(platformColor(p));

    const missingTags = [...used].filter((c) => !tags.has(c));
    const missingTones = [...used].filter((c) => !tones.has(c));

    expect(missingTags).toEqual([]);
    expect(missingTones).toEqual([]);
  });

  it('шаблоны не возвращаются к бейджам без цвета текста', () => {
    // Сплошной `badge bg-<цвет>` в Tabler не задаёт цвет текста — надпись
    // сливается с фоном. Метки только через `tag`, цветной текст — `tone`.
    // layout.ejs пропускается: в его комментарии эта ошибка описана словами.
    const dir = join(__dirname, 'views');
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.ejs') && file !== 'layout.ejs')
      .filter((file) =>
        /class="[^"]*\b(badge bg-|text-(green|red|orange|yellow|azure|blue|teal|purple)\b)/.test(
          readFileSync(join(dir, file), 'utf8'),
        ),
      );

    expect(offenders).toEqual([]);
  });
});
