import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Center,
  Code,
  Group,
  Loader,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { formatDateTime } from '../format';
import type { AuditRow } from '@white-bot/shared';

const PAGE = 100;

const ACTIONS = [
  { value: '', label: 'Все действия' },
  { value: 'contest.', label: 'Конкурсы' },
  { value: 'post.', label: 'Посты' },
  { value: 'template.', label: 'Повторяющиеся' },
  { value: 'group.', label: 'Каналы' },
  { value: 'admin.', label: 'Админы' },
  { value: 'auth.', label: 'Входы' },
  { value: 'audit.', label: 'Очистка журнала' },
];

const PERIODS = [
  { value: '1', label: 'Сегодня и вчера' },
  { value: '7', label: 'Последние 7 дней' },
  { value: '30', label: 'Последние 30 дней' },
  { value: '', label: 'Всё время' },
];

export function AuditPage() {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [period, setPeriod] = useState('7');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [open, setOpen] = useState<string | null>(null);

  const admins = useQuery({
    queryKey: ['admins'],
    queryFn: () => api<{ id: string; email: string }[]>('GET', '/api/admins'),
  });
  // Граница периода считается один раз на смену фильтра, а не на каждой странице.
  const [since] = useState(() => new Map<string, string>());
  const sinceFor = (p: string) => {
    if (!p) return '';
    if (!since.has(p)) since.set(p, new Date(Date.now() - Number(p) * 24 * 60 * 60 * 1000).toISOString());
    return since.get(p)!;
  };

  const rows = useInfiniteQuery({
    queryKey: ['audit', actor, action, period, q],
    initialPageParam: null as { at: string; id: string } | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE) });
      if (actor) params.set('actor', actor);
      if (action) params.set('actionPrefix', action);
      if (period) params.set('since', sinceFor(period));
      if (q) params.set('q', q);
      if (pageParam) {
        params.set('beforeAt', pageParam.at);
        params.set('beforeId', pageParam.id);
      }
      return api<AuditRow[]>('GET', `/audit?${params}`);
    },
    getNextPageParam: (last) => (last.length < PAGE ? null : { at: last.at(-1)!.at, id: last.at(-1)!.id }),
  });
  const list = rows.data?.pages.flat() ?? [];

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Stack gap={2}>
        <Title order={1} size="h2">
          Журнал действий
        </Title>
        <Text c="dimmed" size="sm">
          Кто, что и когда сделал в панели. Записи хранятся 30 дней.
        </Text>
      </Stack>

      <Group grow align="flex-end" wrap="wrap">
        <Select
          label="Кто"
          value={actor}
          onChange={(v) => setActor(v ?? '')}
          data={[
            { value: '', label: 'Все' },
            { value: 'system', label: 'Автоматика' },
            { value: 'bot', label: 'Бот' },
            ...(admins.data ?? []).map((a) => ({
              value: a.id,
              label: a.email,
            })),
          ]}
        />
        <Select label="Что" value={action} onChange={(v) => setAction(v ?? '')} data={ACTIONS} />
        <Select label="Период" value={period} onChange={(v) => setPeriod(v ?? '')} data={PERIODS} />
        <TextInput
          label="Поиск"
          placeholder="Конкурс, пост, канал"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
      </Group>

      {rows.isPending && (
        <Center py="xl">
          <Loader />
        </Center>
      )}
      {rows.isError && <Alert color="red">{rows.error.message}</Alert>}
      {rows.isSuccess && list.length === 0 && (
        <Text c="dimmed" ta="center" py="xl">
          Ничего не нашлось.
        </Text>
      )}
      {list.length > 0 && (
        <Card withBorder radius="lg" p={0}>
          <Table.ScrollContainer minWidth={640}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={130}>Когда</Table.Th>
                  <Table.Th w={180}>Кто</Table.Th>
                  <Table.Th>Что сделал</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((r) => (
                  <Table.Tr
                    key={r.id}
                    onClick={() => setOpen(open === r.id ? null : r.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <Table.Td>
                      <Text size="sm">{formatDateTime(r.at)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" truncate>
                        {r.actor?.email ??
                          (r.actorType === 'system' ? 'автоматика' : r.actorType === 'bot' ? 'бот' : '—')}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{r.summary}</Text>
                      {open === r.id && r.details != null && (
                        <Code block mt="xs">
                          {JSON.stringify(r.details, null, 2)}
                        </Code>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
      {rows.hasNextPage && (
        <Button
          variant="default"
          loading={rows.isFetchingNextPage}
          onClick={() => void rows.fetchNextPage()}
          style={{ alignSelf: 'center' }}
        >
          Показать ещё
        </Button>
      )}
      <Text size="xs" c="dimmed">
        Нажатие на запись открывает подробности: старое и новое значение.
      </Text>
    </Stack>
  );
}
