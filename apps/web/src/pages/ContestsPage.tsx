import { useState } from 'react';
import { Alert, Badge, Box, Button, Card, Center, Group, Image, Loader, Stack, Tabs, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, previewUrl, type ContestStatus, type ContestSummary, type NotifyStatus } from '../api';
import { formatCount, formatDate, formatDateTime, plural, timeLeft } from '../format';

const STATUS: Record<ContestStatus, { label: string; color: string }> = {
  draft: { label: 'Черновик', color: 'gray' },
  open: { label: 'Идёт приём', color: 'green' },
  drawn: { label: 'Итоги подведены', color: 'blue' },
  cancelled: { label: 'Отменён', color: 'red' },
};

const FILTERS = [
  { value: 'all', label: 'Все', match: () => true },
  {
    value: 'open',
    label: 'Идут',
    match: (c: ContestSummary) => c.status === 'open',
  },
  {
    value: 'draft',
    label: 'Черновики',
    match: (c: ContestSummary) => c.status === 'draft',
  },
  {
    value: 'done',
    label: 'Завершены',
    match: (c: ContestSummary) => c.status === 'drawn' || c.status === 'cancelled',
  },
];

const NOTIFY: Record<NotifyStatus, string> = {
  pending: 'уведомление в очереди',
  sent: 'уведомлён',
  failed: 'не уведомлён',
  manual_required: 'уведомить вручную',
  notified_manually: 'уведомлён вручную',
};

export function ContestsPage() {
  const [filter, setFilter] = useState('all');
  const contests = useQuery({
    queryKey: ['contests'],
    queryFn: () => api<ContestSummary[]>('GET', '/api/contests'),
  });

  const list = contests.data ?? [];
  const shown = list.filter(FILTERS.find((f) => f.value === filter)!.match);

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Group justify="space-between">
        <Title order={1} size="h2">
          Конкурсы
        </Title>
        <Button component={Link} to="/contests/new" size="md" leftSection={<span aria-hidden="true">+</span>}>
          Новый конкурс
        </Button>
      </Group>

      <Tabs value={filter} onChange={(v) => setFilter(v ?? 'all')} variant="pills" radius="md">
        <Tabs.List>
          {FILTERS.map((f) => (
            <Tabs.Tab key={f.value} value={f.value}>
              {f.label} · {list.filter(f.match).length}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>

      {contests.isPending && (
        <Center py="xl">
          <Loader />
        </Center>
      )}
      {contests.isError && <Alert color="red">Не удалось загрузить конкурсы: {contests.error.message}</Alert>}
      {contests.isSuccess && shown.length === 0 && (
        <Text c="dimmed" py="xl" ta="center">
          {list.length === 0 ? 'Конкурсов пока нет.' : 'В этом разделе пусто.'}
        </Text>
      )}

      <Stack gap="sm">
        {shown.map((contest) => (
          <ContestRow key={contest.id} contest={contest} />
        ))}
      </Stack>
    </Stack>
  );
}

function ContestRow({ contest }: { contest: ContestSummary }) {
  const status = STATUS[contest.status];
  const when = whenFigure(contest);

  return (
    <Card component={Link} to={`/contests/${contest.id}`} withBorder radius="lg" p="md">
      <Group wrap="wrap" gap="md" align="center">
        <Thumbnail mediaId={contest.imageMediaId} />
        <Stack gap={6} style={{ flex: '1 1 260px', minWidth: 0 }}>
          <Group gap="xs">
            <Text fw={600} size="lg">
              {contest.title}
            </Text>
            <Badge color={status.color} variant="light" radius="xl">
              {status.label}
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">
            {subtitle(contest)}
          </Text>
        </Stack>
        <Group gap="xl" wrap="wrap">
          <Figure
            value={
              contest.participantsCount > 0 || contest.status !== 'draft' ? formatCount(contest.participantsCount) : '—'
            }
            caption={plural(contest.participantsCount, ['участник', 'участника', 'участников'])}
          />
          <Figure
            value={String(contest.placesCount)}
            caption={plural(contest.placesCount, ['место', 'места', 'мест'])}
          />
          {when && <Figure value={when.value} caption={when.caption} small />}
        </Group>
      </Group>
    </Card>
  );
}

function Thumbnail({ mediaId }: { mediaId: string | null }) {
  if (mediaId) {
    return (
      <Image src={previewUrl(mediaId)} alt="" w={72} h={72} radius="md" fit="cover" style={{ flex: '0 0 auto' }} />
    );
  }
  return <Box w={72} h={72} bg="gray.1" style={{ borderRadius: 'var(--mantine-radius-md)', flex: '0 0 auto' }} />;
}

function Figure({ value, caption, small }: { value: string; caption: string; small?: boolean }) {
  return (
    <div>
      <Text fw={small ? 600 : 700} size={small ? 'md' : 'xl'} pt={small ? 3 : 0}>
        {value}
      </Text>
      <Text size="xs" c="dimmed">
        {caption}
      </Text>
    </div>
  );
}

function subtitle(contest: ContestSummary): string {
  const parts: string[] = [];
  if (contest.channels.length > 0) parts.push(contest.channels.join(', '));

  if (contest.status === 'draft') {
    const publishAt = contest.scheduledAt ?? contest.startsAt;
    if (publishAt) parts.push(`публикация ${formatDateTime(publishAt)}`);
  } else if (contest.status === 'open' && contest.requiredGroups.length > 0) {
    parts.push(`условие: подписка на ${contest.requiredGroups.map((g) => `«${g}»`).join(', ')}`);
  } else if (contest.status === 'drawn') {
    const [first] = contest.winners;
    if (contest.winners.length === 1 && first) {
      parts.push(`победитель: ${first.name}`, NOTIFY[first.notifyStatus]);
    } else if (contest.winners.length > 1) {
      const notified = contest.winners.filter(
        (w) => w.notifyStatus === 'sent' || w.notifyStatus === 'notified_manually',
      ).length;
      parts.push(`победителей: ${contest.winners.length}`, `уведомлено ${notified} из ${contest.winners.length}`);
    }
  } else if (contest.status === 'cancelled') {
    parts.push('не набралось участников');
  }
  return parts.join(' · ') || 'Без публикации';
}

function whenFigure(contest: ContestSummary): { value: string; caption: string } | null {
  switch (contest.status) {
    case 'draft': {
      const publishAt = contest.scheduledAt ?? contest.startsAt;
      if (!publishAt) return null;
      // Время подошло — подхватит ближайший проход сверки.
      if (Date.parse(publishAt) <= Date.now()) return { value: 'вот-вот', caption: 'публикация' };
      return { value: `через ${timeLeft(publishAt)}`, caption: 'публикация' };
    }
    case 'open':
      return contest.endsAt
        ? { value: timeLeft(contest.endsAt), caption: 'до розыгрыша' }
        : { value: 'вручную', caption: 'розыгрыш' };
    case 'drawn':
      return contest.drawnAt ? { value: formatDate(contest.drawnAt), caption: 'разыгран' } : null;
    case 'cancelled':
      return contest.endsAt ? { value: formatDate(contest.endsAt), caption: 'отменён' } : null;
  }
}
