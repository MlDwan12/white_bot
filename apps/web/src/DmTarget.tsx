import { useState } from 'react';
import { Radio, Select, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type PlatformUser } from './api';
import { useChannels } from './hooks';

export type DmTargetValue =
  | { mode: 'user'; platformUserId: string | null }
  | { mode: 'group'; groupId: string | null }
  | { mode: 'all' };

export function dmTargetReady(t: DmTargetValue): boolean {
  return t.mode === 'all' || (t.mode === 'user' ? !!t.platformUserId : !!t.groupId);
}

/** Кому слать в личку. Только MAX: через VK бот личных сообщений не шлёт. */
export function DmTarget({ value, onChange }: { value: DmTargetValue; onChange: (v: DmTargetValue) => void }) {
  const channels = useChannels();
  const maxGroups = (channels.data ?? []).filter((c) => c.platform === 'max');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const users = useQuery({
    queryKey: ['platform-users', q],
    queryFn: () => api<PlatformUser[]>('GET', `/api/platform-users?${new URLSearchParams({ q })}`),
    enabled: value.mode === 'user' && q.length > 0,
    placeholderData: keepPreviousData,
  });

  return (
    <Radio.Group
      label="Кому"
      value={value.mode}
      onChange={(mode) =>
        onChange(
          mode === 'user'
            ? { mode: 'user', platformUserId: null }
            : mode === 'group'
              ? { mode: 'group', groupId: maxGroups[0]?.id ?? null }
              : { mode: 'all' },
        )
      }
    >
      <Stack gap="xs" mt="xs">
        <Radio value="user" label="Конкретному человеку" />
        {value.mode === 'user' && (
          <Select
            aria-label="Получатель"
            placeholder="Имя, ник или id в MAX"
            searchable
            searchValue={search}
            onSearchChange={setSearch}
            filter={({ options }) => options}
            nothingFoundMessage={q ? (users.isFetching ? 'Ищем…' : 'Никого не нашлось') : 'Начните вводить'}
            data={(users.data ?? []).map((u) => ({
              value: u.id,
              label: `${u.displayName}${u.username ? ` @${u.username}` : ''} · ${u.externalUserId}`,
            }))}
            value={value.platformUserId}
            onChange={(id) => onChange({ mode: 'user', platformUserId: id })}
          />
        )}
        <Radio value="group" label="Участникам группы" />
        {value.mode === 'group' && (
          <>
            <Select
              aria-label="Группа"
              data={maxGroups.map((g) => ({ value: g.id, label: g.title }))}
              value={value.groupId}
              onChange={(id) => onChange({ mode: 'group', groupId: id })}
            />
            <Text size="xs" c="dimmed">
              Все согласившиеся участники конкурсов, чей анонс уходил в эту группу.
            </Text>
          </>
        )}
        <Radio value="all" label="Всем в базе" />
      </Stack>
    </Radio.Group>
  );
}
