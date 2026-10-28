import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  Progress,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMe } from '../../hooks';
import { api, openWithSession, type ContestDetails, type FunnelStats, type ParticipantsPage } from '../../api';
import { NOTIFY } from '../../contestLabels';
import { formatCount, formatDateTime } from '../../format';
import type { Run } from '../../useAction';

function useParticipants(contestId: string, q: string, offset: number) {
  return useQuery({
    queryKey: ['participants', contestId, q, offset],
    queryFn: () =>
      api<ParticipantsPage>(
        'GET',
        `/api/contests/${contestId}/participants?${new URLSearchParams({ q, offset: String(offset) })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function ParticipantsTab({ contest, run }: { contest: ContestDetails; run: Run }) {
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const page = useParticipants(contest.id, q, offset);
  const finished = contest.status === 'drawn' || contest.status === 'cancelled';

  return (
    <Stack gap="md">
      <Group gap="sm">
        <TextInput
          style={{ flex: '1 1 240px' }}
          aria-label="Поиск участника"
          placeholder="Поиск по имени или нику"
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setOffset(0);
          }}
        />
        {!finished && (
          <Button variant="default" onClick={() => setAdding(true)}>
            Добавить вручную
          </Button>
        )}
        <Button
          variant="default"
          onClick={() => void openWithSession(`/api/contests/${contest.id}/participants.csv`).catch(() => undefined)}
        >
          Выгрузить CSV
        </Button>
      </Group>

      {page.isPending && <Loader />}
      {page.isError && <Alert color="red">{page.error.message}</Alert>}
      {page.data && (
        <>
          <Table.ScrollContainer minWidth={560}>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Участник</Table.Th>
                  <Table.Th>Откуда</Table.Th>
                  <Table.Th>Когда</Table.Th>
                  <Table.Th>Способ</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {page.data.items.map((p) => (
                  <Table.Tr key={p.id}>
                    <Table.Td>{p.name}</Table.Td>
                    <Table.Td>{p.group ?? '—'}</Table.Td>
                    <Table.Td>{formatDateTime(p.joinedAt)}</Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={p.source === 'manual' ? 'grape' : 'gray'}>
                        {p.source === 'manual' ? 'вручную' : 'кнопка'}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {page.data.total === 0 ? (
            <Text c="dimmed" ta="center">
              {q ? 'Никого не нашлось.' : 'Участников пока нет.'}
            </Text>
          ) : (
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                Показано {offset + 1}–{offset + page.data.items.length} из {formatCount(page.data.total)}
              </Text>
              <Group gap="xs">
                <Button
                  variant="default"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - page.data.pageSize))}
                >
                  Назад
                </Button>
                <Button
                  variant="default"
                  disabled={offset + page.data.pageSize >= page.data.total}
                  onClick={() => setOffset(offset + page.data.pageSize)}
                >
                  Дальше
                </Button>
              </Group>
            </Group>
          )}
        </>
      )}

      {adding && <AddParticipantsModal contest={contest} run={run} onClose={() => setAdding(false)} />}
    </Stack>
  );
}

function AddParticipantsModal({ contest, run, onClose }: { contest: ContestDetails; run: Run; onClose: () => void }) {
  const [text, setText] = useState('');
  const [platform, setPlatform] = useState<'max' | 'vk'>('max');
  const me = useMe();
  const showVk = me.data?.role === 'developer';

  const submit = async () => {
    const ok = await run(
      () =>
        api<{ added: number; duplicateLines: number[] }>('POST', `/api/contests/${contest.id}/participants`, {
          text,
          platform,
        }),
      (result) => {
        const r = result as { added: number; duplicateLines: number[] };
        return {
          color: 'green',
          text:
            r.duplicateLines.length > 0
              ? `Добавлено: ${r.added}. Уже были в списке, строки: ${r.duplicateLines.join(', ')}`
              : `Добавлено: ${r.added}`,
        };
      },
    );
    if (ok) onClose();
  };

  return (
    <Modal opened onClose={onClose} title="Добавить участников вручную" size="lg" centered>
      <Stack>
        <Textarea
          label="По одному на строку"
          description="Имя и ссылка на профиль или ник: «Мария @maria_l». Без ссылки участник не получит уведомление."
          autosize
          minRows={6}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        {showVk && (
          <SegmentedControl
            value={platform}
            onChange={(v) => setPlatform(v as 'max' | 'vk')}
            data={[
              { value: 'max', label: 'MAX' },
              { value: 'vk', label: 'VK' },
            ]}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={!text.trim()} onClick={() => void submit()}>
            Добавить
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function ResultsTab({ contest, run }: { contest: ContestDetails; run: Run }) {
  const [picking, setPicking] = useState<{
    prizeId: string;
    place: number;
    mode: 'force' | 'override';
  } | null>(null);
  const drawn = contest.status === 'drawn';
  const lastDraw = contest.drawLogs.find((l) => l.kind === 'draw');

  if (contest.prizes.length === 0) {
    return <Text c="dimmed">Призовых мест нет — добавьте их на вкладке «Обзор».</Text>;
  }

  return (
    <Stack gap="lg">
      {!drawn && contest.status !== 'cancelled' && (
        <Text size="sm" c="dimmed">
          До розыгрыша место можно закрепить за участником — остальные разыграются случайно.
        </Text>
      )}
      <Stack gap="sm">
        {contest.prizes.map((prize) => {
          const notify = NOTIFY[prize.notifyStatus];
          return (
            <Card key={prize.id} withBorder radius="lg" p="md">
              <Group wrap="wrap" gap="md">
                <Badge size="xl" circle variant="light">
                  {prize.place}
                </Badge>
                <Stack gap={2} style={{ flex: '1 1 200px' }}>
                  <Text fw={600}>{prize.winner?.name ?? (drawn ? 'без победителя' : '—')}</Text>
                  <Text size="sm" c="dimmed">
                    {prize.label}
                    {prize.winner?.source === 'manual' ? ' · добавлен вручную' : ''}
                    {prize.isForced && prize.winner ? ' · закреплён' : ''}
                  </Text>
                </Stack>
                {drawn && prize.winner && (
                  <Badge color={notify.color} variant="light" title={prize.notifyError ?? undefined}>
                    {notify.label}
                  </Badge>
                )}
                {drawn &&
                  prize.winner &&
                  (prize.notifyStatus === 'failed' || prize.notifyStatus === 'manual_required') && (
                    <Button
                      variant="default"
                      onClick={() =>
                        void run(
                          () => api('POST', `/api/contests/${contest.id}/prizes/${prize.id}/notified`),
                          'Отмечено: уведомлён вручную',
                        )
                      }
                    >
                      Отметить: уведомлён
                    </Button>
                  )}
                {drawn && (
                  <Button
                    variant="default"
                    onClick={() =>
                      setPicking({
                        prizeId: prize.id,
                        place: prize.place,
                        mode: 'override',
                      })
                    }
                  >
                    Заменить
                  </Button>
                )}
                {contest.status === 'open' || contest.status === 'draft' ? (
                  <Button
                    variant="default"
                    onClick={() =>
                      setPicking({
                        prizeId: prize.id,
                        place: prize.place,
                        mode: 'force',
                      })
                    }
                  >
                    {prize.winner ? 'Закрепить другого' : 'Закрепить участника'}
                  </Button>
                ) : null}
              </Group>
            </Card>
          );
        })}
      </Stack>

      {lastDraw && (
        <Card withBorder radius="lg" p="lg">
          <Title order={2} size="h4" mb="xs">
            Честность розыгрыша
          </Title>
          <Text size="sm">
            Пул: {lastDraw.poolSize ?? '—'} участников.
            {lastDraw.disqualified ? ` Выбыли из-за отписки: ${lastDraw.disqualified}.` : ''}
            {lastDraw.seed ? ' Сид сохранён — итог можно пересчитать.' : ''}
          </Text>
          <Text size="xs" c="dimmed">
            {formatDateTime(lastDraw.drawnAt)} · {lastDraw.actor ?? 'автоматически'}
          </Text>
        </Card>
      )}

      {picking && <PickWinnerModal contest={contest} run={run} picking={picking} onClose={() => setPicking(null)} />}
    </Stack>
  );
}

function PickWinnerModal({
  contest,
  run,
  picking,
  onClose,
}: {
  contest: ContestDetails;
  run: Run;
  picking: { prizeId: string; place: number; mode: 'force' | 'override' };
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const page = useParticipants(contest.id, q, 0);
  const override = picking.mode === 'override';

  const submit = async () => {
    if (!participantId) return;
    const ok = await run(
      () =>
        api('POST', `/api/contests/${contest.id}/prizes/${picking.prizeId}/${override ? 'override' : 'force'}-winner`, {
          participantId,
          note: note.trim() || undefined,
        }),
      override ? 'Победитель заменён' : 'Место закреплено',
    );
    if (ok) onClose();
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={`${override ? 'Заменить победителя' : 'Закрепить'} · ${picking.place} место`}
      centered
    >
      <Stack>
        <Select
          label="Участник"
          placeholder="Начните вводить имя или ник"
          searchable
          searchValue={search}
          onSearchChange={setSearch}
          filter={({ options }) => options}
          nothingFoundMessage={page.isFetching ? 'Ищем…' : 'Никого не нашлось'}
          data={(page.data?.items ?? []).map((p) => ({
            value: p.id,
            label: p.name,
          }))}
          value={participantId}
          onChange={setParticipantId}
        />
        {override && (
          <TextInput
            label="Причина замены"
            description="Попадёт в журнал розыгрыша"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={!participantId} onClick={() => void submit()}>
            {override ? 'Заменить' : 'Закрепить'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function JournalTab({ contest }: { contest: ContestDetails }) {
  if (contest.drawLogs.length === 0) {
    return <Text c="dimmed">Розыгрыша ещё не было.</Text>;
  }
  return (
    <Stack gap="sm">
      {contest.drawLogs.map((log) => (
        <Card key={log.id} withBorder radius="md" p="md">
          <Text fw={600}>
            {log.kind === 'draw'
              ? `Розыгрыш · пул ${log.poolSize ?? '—'}${log.disqualified ? `, выбыло ${log.disqualified}` : ''}`
              : `Замена · ${log.place} место: ${log.previous ?? '—'} → ${log.next ?? '—'}`}
          </Text>
          {log.note && <Text size="sm">{log.note}</Text>}
          <Text size="xs" c="dimmed">
            {formatDateTime(log.drawnAt)} · {log.actor ?? 'автоматически'}
            {log.seed ? ` · сид ${log.seed}` : ''}
          </Text>
        </Card>
      ))}
    </Stack>
  );
}

export function StatsTab({ contest }: { contest: ContestDetails }) {
  const funnel = useQuery({
    queryKey: ['funnel', contest.id],
    queryFn: () => api<FunnelStats>('GET', `/api/contests/${contest.id}/funnel`),
  });
  if (funnel.isPending) return <Loader />;
  if (funnel.isError) return <Alert color="red">{funnel.error.message}</Alert>;

  const stats = funnel.data;
  const consented = stats.consented ?? 0;
  const rows = [
    { label: 'Дали согласие в боте', value: consented },
    { label: 'Не прошли проверку подписки', value: stats.not_subscribed ?? 0 },
    { label: 'Стали участниками', value: stats.joined ?? 0 },
  ];
  return (
    <Card withBorder radius="lg" p="lg">
      <Title order={2} size="h4" mb="md">
        Путь от кнопки до участия
      </Title>
      <Stack gap="md">
        {rows.map(({ label, value }) => (
          <div key={label}>
            <Group justify="space-between">
              <Text size="sm">{label}</Text>
              <Text size="sm" fw={600}>
                {formatCount(value)}
                {consented > 0 && value !== consented ? ` · ${Math.round((value / consented) * 100)}%` : ''}
              </Text>
            </Group>
            <Progress value={consented > 0 ? (value / consented) * 100 : 0} size="lg" radius="sm" />
          </div>
        ))}
        <Text size="sm" c="dimmed">
          Люди считаются по разу на этап. Нажатий «Начать» до согласия: {formatCount(stats.anonymousStarts ?? 0)} — это
          нажатия, а не люди: до согласия бот никого не запоминает.
          {(stats.already_joined ?? 0) > 0
            ? ` Нажали повторно, уже участвуя: ${formatCount(stats.already_joined)}.`
            : ''}
        </Text>
      </Stack>
    </Card>
  );
}
