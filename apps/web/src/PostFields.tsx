import { useState } from 'react';
import {
  Anchor,
  Button,
  Card,
  Checkbox,
  Group,
  NumberInput,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { RichText } from './RichText';
import type { ChannelOption, Media, PostStatus } from './api';
import { toLocalInput } from './format';
import { MediaPicker } from './MediaPicker';

export const POST_STATUS: Record<PostStatus, { label: string; color: string }> = {
  draft: { label: 'Черновик', color: 'gray' },
  scheduled: { label: 'Запланирован', color: 'blue' },
  sending: { label: 'Отправляется', color: 'blue' },
  sent: { label: 'Отправлен', color: 'green' },
  partially_failed: { label: 'Частично', color: 'orange' },
  stopped: { label: 'Остановлен', color: 'gray' },
};

export interface PostDraft {
  text: string;
  vkTextOverride: string;
  maxTextOverride: string;
  attachments: Media[];
  groupIds: string[];
  /** '' — отправить сразу. */
  scheduledAt: string;
  /** null — не удалять. */
  autoDeleteAfterMinutes: number | null;
}

export const EMPTY_POST: PostDraft = {
  text: '',
  vkTextOverride: '',
  maxTextOverride: '',
  attachments: [],
  groupIds: [],
  scheduledAt: '',
  autoDeleteAfterMinutes: null,
};

export function draftPayload(draft: PostDraft) {
  return {
    text: draft.text,
    vkTextOverride: draft.vkTextOverride,
    maxTextOverride: draft.maxTextOverride,
    attachmentIds: draft.attachments.map((m) => m.id),
    groupIds: draft.groupIds,
    scheduledAt: draft.scheduledAt || undefined,
    autoDeleteAfterMinutes: draft.autoDeleteAfterMinutes,
  };
}

const DAY = 24 * 60;

/** Поля поста: текст, вложения, каналы, время. Без кнопок — их ставит страница. */
export function PostFields({
  value,
  onChange,
  channels,
  showSchedule = true,
}: {
  value: PostDraft;
  onChange: (next: PostDraft) => void;
  channels: ChannelOption[];
  showSchedule?: boolean;
}) {
  const set = <K extends keyof PostDraft>(key: K, v: PostDraft[K]) => onChange({ ...value, [key]: v });
  const [overrides, setOverrides] = useState(Boolean(value.vkTextOverride || value.maxTextOverride));
  const hasVk = channels.some((c) => c.platform === 'vk');

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
      <Stack>
        <RichText label="Текст" minRows={6} value={value.text} onChange={(v) => set('text', v)} />
        {overrides ? (
          <>
            <RichText
              label="Текст для MAX"
              description="Пусто — общий текст"

              minRows={3}
              value={value.maxTextOverride}
              onChange={(v) => set('maxTextOverride', v)}
            />
            {hasVk && (
              <RichText
                label="Текст для VK"
                description="Пусто — общий текст"

                minRows={3}
                value={value.vkTextOverride}
                onChange={(v) => set('vkTextOverride', v)}
              />
            )}
          </>
        ) : (
          <Anchor component="button" size="sm" onClick={() => setOverrides(true)} style={{ alignSelf: 'flex-start' }}>
            Отдельный текст для {hasVk ? 'VK или MAX' : 'MAX'}
          </Anchor>
        )}
        <MediaPicker value={value.attachments} onChange={(v) => set('attachments', v)} />
      </Stack>

      <Stack>
        <Card withBorder radius="lg" p="lg">
          <Title order={2} size="h4" mb="sm">
            Куда
          </Title>
          <ChannelPicker channels={channels} value={value.groupIds} onChange={(v) => set('groupIds', v)} />
        </Card>
        {showSchedule && (
          <Card withBorder radius="lg" p="lg">
            <Stack>
              <Radio.Group
                label="Когда"
                value={value.scheduledAt === '' ? 'now' : 'scheduled'}
                onChange={(v) => set('scheduledAt', v === 'now' ? '' : defaultSchedule())}
              >
                <Group mt="xs">
                  <Radio value="now" label="Сейчас" />
                  <Radio value="scheduled" label="Запланировать" />
                </Group>
              </Radio.Group>
              {value.scheduledAt !== '' && (
                <TextInput
                  type="datetime-local"
                  aria-label="Время отправки"
                  value={value.scheduledAt}
                  onChange={(e) => set('scheduledAt', e.currentTarget.value)}
                />
              )}
              <AutoDelete value={value.autoDeleteAfterMinutes} onChange={(v) => set('autoDeleteAfterMinutes', v)} />
            </Stack>
          </Card>
        )}
      </Stack>
    </SimpleGrid>
  );
}

export function AutoDelete({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const mode = value === null ? 'never' : value === DAY ? 'day' : 'custom';
  return (
    <Stack gap="xs">
      <Radio.Group
        label="Удалить автоматически"
        value={mode}
        onChange={(v) => onChange(v === 'never' ? null : v === 'day' ? DAY : 60)}
      >
        <Group mt="xs">
          <Radio value="never" label="Не удалять" />
          <Radio value="day" label="Через 24 часа" />
          <Radio value="custom" label="Через…" />
        </Group>
      </Radio.Group>
      {mode === 'custom' && (
        <NumberInput
          aria-label="Через сколько часов удалить"
          suffix=" ч"
          min={1}
          max={24 * 365}
          value={Math.round((value ?? 60) / 60)}
          onChange={(v) => onChange(Math.max(1, Number(v) || 1) * 60)}
        />
      )}
    </Stack>
  );
}

/** Каналы с быстрым выбором по тегу и по сети. */
export function ChannelPicker({
  channels,
  value,
  onChange,
}: {
  channels: ChannelOption[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [listOpen, setListOpen] = useState(value.length === 0);
  const tags = [...new Set(channels.flatMap((c) => c.tags))].sort();
  const add = (ids: string[]) => onChange([...new Set([...value, ...ids])]);
  const byPlatform = (p: 'max' | 'vk') => channels.filter((c) => c.platform === p).map((c) => c.id);
  const chosen = channels.filter((c) => value.includes(c.id));

  if (channels.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Нет активных каналов.
      </Text>
    );
  }

  return (
    <Stack gap="sm">
      <Group gap="xs">
        {tags.map((tag) => {
          const ids = channels.filter((c) => c.tags.includes(tag)).map((c) => c.id);
          return (
            <Button key={tag} size="xs" variant="light" radius="xl" onClick={() => add(ids)}>
              #{tag} · {ids.length}
            </Button>
          );
        })}
        <Button size="xs" variant="light" radius="xl" color="gray" onClick={() => add(byPlatform('max'))}>
          Все MAX
        </Button>
        {byPlatform('vk').length > 0 && (
          <Button size="xs" variant="light" radius="xl" color="gray" onClick={() => add(byPlatform('vk'))}>
            Все VK
          </Button>
        )}
        {value.length > 0 && (
          <Button size="xs" variant="subtle" color="gray" onClick={() => onChange([])}>
            Сбросить
          </Button>
        )}
      </Group>
      {!listOpen && (
        <Text size="sm">
          Выбрано {chosen.length}: {chosen.map((c) => `${c.title} (${c.platform.toUpperCase()})`).join(', ')} ·{' '}
          <Anchor component="button" onClick={() => setListOpen(true)}>
            изменить список
          </Anchor>
        </Text>
      )}
      {listOpen && (
        <Stack gap={6}>
          {channels.map((c) => (
            <Checkbox
              key={c.id}
              label={c.title}
              description={`${c.platform.toUpperCase()}${c.tags.length ? ' · ' + c.tags.map((t) => `#${t}`).join(' ') : ''}`}
              checked={value.includes(c.id)}
              onChange={(e) => onChange(e.currentTarget.checked ? [...value, c.id] : value.filter((id) => id !== c.id))}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/** Через час от сейчас, ровно в начале часа, по Москве — стартовое значение для «Запланировать». */
function defaultSchedule(): string {
  return `${toLocalInput(new Date(Date.now() + 60 * 60 * 1000).toISOString()).slice(0, 14)}00`;
}
