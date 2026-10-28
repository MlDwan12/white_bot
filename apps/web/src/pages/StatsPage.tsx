import { useState } from 'react';
import {
  Alert,
  Anchor,
  Box,
  Card,
  Center,
  Group,
  Loader,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api';
import { formatCount, formatDate, formatDateTime, plural } from '../format';
import type { StatsReport } from '@white-bot/shared';

const percent = (x: number) => `${(x * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;

export function StatsPage() {
  const [days, setDays] = useState('30');
  const query = useQuery({
    queryKey: ['stats', days],
    queryFn: () => api<StatsReport>('GET', `/api/stats?days=${days}`),
    placeholderData: keepPreviousData,
  });

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Group justify="space-between">
        <Title order={1} size="h2">
          Статистика
        </Title>
        <SegmentedControl
          value={days}
          onChange={setDays}
          data={[
            { value: '7', label: '7 дней' },
            { value: '30', label: '30 дней' },
            { value: '365', label: 'Год' },
          ]}
        />
      </Group>
      {query.isPending && (
        <Center py="xl">
          <Loader />
        </Center>
      )}
      {query.isError && <Alert color="red">{query.error.message}</Alert>}
      {query.data && <StatsBody s={query.data} />}
    </Stack>
  );
}

function StatsBody({ s }: { s: StatsReport }) {
  const max = Math.max(1, ...s.weekly.map((w) => w.count));
  return (
    <>
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Tile
          label="Постов отправлено"
          value={formatCount(s.posts.sent)}
          hint={`в ${s.posts.channels} ${plural(s.posts.channels, ['канал', 'канала', 'каналов'])}`}
        />
        <Tile
          label="Доставлено с первой попытки"
          value={s.deliveries.attempted ? percent(s.deliveries.firstTry / s.deliveries.attempted) : '—'}
          hint={`${formatCount(s.deliveries.failed)} ошибок из ${formatCount(s.deliveries.attempted)}`}
        />
        <Tile label="Конкурсов проведено" value={formatCount(s.contests.drawn)} hint={`ещё ${s.contests.open} идут`} />
        <Tile
          label="Участников всего"
          value={formatCount(s.participants.total)}
          hint={`уникальных — ${formatCount(s.participants.unique)}`}
        />
      </SimpleGrid>

      <Card withBorder radius="lg" p="lg">
        <Title order={2} size="h4" mb="md">
          Новые участники конкурсов по неделям
        </Title>
        {s.weekly.length === 0 ? (
          <Text c="dimmed">За период участников не было.</Text>
        ) : (
          <Group align="flex-end" gap={6} h={180} wrap="nowrap" style={{ overflowX: 'auto' }}>
            {s.weekly.map((w) => (
              <Tooltip key={w.week} label={`Неделя с ${formatDate(w.week)}: ${formatCount(w.count)}`}>
                <Stack gap={4} align="center" style={{ flex: '1 0 28px' }} h="100%" justify="flex-end">
                  <Box
                    w="100%"
                    bg="blue.5"
                    style={{
                      height: `${(w.count / max) * 140}px`,
                      minHeight: 2,
                      borderRadius: '4px 4px 0 0',
                    }}
                  />
                  <Text size="xs" c="dimmed">
                    {formatDate(w.week)}
                  </Text>
                </Stack>
              </Tooltip>
            ))}
          </Group>
        )}
      </Card>

      <Card withBorder radius="lg" p={0}>
        <Title order={2} size="h4" p="lg" pb={0}>
          По каналам: доставка и участники
        </Title>
        <Table.ScrollContainer minWidth={480}>
          <Table verticalSpacing="sm" horizontalSpacing="lg">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Канал</Table.Th>
                <Table.Th ta="right">Доставлено</Table.Th>
                <Table.Th ta="right">Участников</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {s.channels.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    {c.title}
                    {c.platform === 'vk' ? ' (VK)' : ''}
                  </Table.Td>
                  <Table.Td ta="right" c={c.delivered !== null && c.delivered < 0.9 ? 'red' : undefined}>
                    {c.delivered === null ? '—' : percent(c.delivered)}
                  </Table.Td>
                  <Table.Td ta="right">{c.participants ? formatCount(c.participants) : '—'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      <Card withBorder radius="lg" p={0}>
        <Title order={2} size="h4" p="lg" pb={0}>
          Кто сколько сделал
        </Title>
        <Table.ScrollContainer minWidth={480}>
          <Table verticalSpacing="sm" horizontalSpacing="lg">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Админ</Table.Th>
                <Table.Th ta="right">Постов</Table.Th>
                <Table.Th ta="right">Конкурсов</Table.Th>
                <Table.Th ta="right">Был в панели</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {s.admins.map((a) => (
                <Table.Tr key={a.id}>
                  <Table.Td>{a.email}</Table.Td>
                  <Table.Td ta="right">{a.posts}</Table.Td>
                  <Table.Td ta="right">{a.contests}</Table.Td>
                  <Table.Td ta="right">{a.lastSeenAt ? formatDateTime(a.lastSeenAt) : '—'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Anchor component={Link} to="/audit" size="sm" p="lg" display="block">
          Все действия в журнале →
        </Anchor>
      </Card>
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card withBorder radius="lg" p="md">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="xl">
        {value}
      </Text>
      <Text size="xs" c="dimmed">
        {hint}
      </Text>
    </Card>
  );
}
