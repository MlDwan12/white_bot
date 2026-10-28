import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  Image,
  Loader,
  Menu,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { RichView } from '../../RichText';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMe } from '../../hooks';
import { api, previewUrl, type ContestDetails } from '../../api';
import { CONTEST_STATUS, DELIVERY } from '../../contestLabels';
import { formatCount, formatDateTime, plural, timeLeft } from '../../format';
import { ConditionsModal, PrizesModal, PublicationModal } from './ContestDialogs';
import { JournalTab, ParticipantsTab, ResultsTab, StatsTab } from './ContestTabs';
import { useAction, type Notice } from '../../useAction';

type Dialog = 'conditions' | 'publication' | 'prizes' | null;

export function ContestPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const tab = search.get('tab') ?? 'overview';
  const [dialog, setDialog] = useState<Dialog>(null);
  const arrived = (useLocation().state as { notice?: Notice } | null)?.notice ?? null;
  const { run, notice, setNotice, pending } = useAction(id, undefined, arrived);

  const me = useMe();
  const query = useQuery({
    queryKey: ['contest', id],
    queryFn: () => api<ContestDetails>('GET', `/api/contests/${id}`),
  });

  if (query.isPending) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (query.isError) {
    return (
      <Stack maw={1040} mx="auto">
        <Anchor component={Link} to="/contests">
          ← Конкурсы
        </Anchor>
        <Alert color="red">{query.error.message}</Alert>
      </Stack>
    );
  }

  const contest = query.data;
  const finished = contest.status === 'drawn' || contest.status === 'cancelled';
  const status = CONTEST_STATUS[contest.status];
  const deliveries = contest.post?.deliveries ?? [];
  const resendable = deliveries.some((d) => d.status === 'failed');
  const canSeeStats = me.data?.permissions.includes('audit_viewAll') ?? false;

  const remove = async () => {
    if (!window.confirm(`Удалить конкурс «${contest.title}»? Публикация будет снята из каналов.`)) return;
    let leftBehind: string[] = [];
    const ok = await run(async () => {
      ({ leftBehind } = await api<{ leftBehind: string[] }>('DELETE', `/api/contests/${id}`));
    }, 'Конкурс удалён');
    if (ok) {
      if (leftBehind.length > 0) {
        window.alert(`Сообщение могло остаться — проверьте и удалите вручную:\n${leftBehind.join('\n')}`);
      }
      navigate('/contests');
    }
  };

  const draw = () => {
    if (!window.confirm('Провести розыгрыш сейчас? Отменить его будет нельзя.')) return;
    void run(() => api('POST', `/api/contests/${id}/draw`), 'Розыгрыш проведён').then(
      (ok) => ok && setSearch({ tab: 'results' }),
    );
  };

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Anchor component={Link} to="/contests" size="sm">
            ← Конкурсы
          </Anchor>
          <Group gap="sm">
            <Title order={1} size="h2">
              {contest.title}
            </Title>
            <Badge color={status.color} variant="light" radius="xl">
              {status.label}
            </Badge>
          </Group>
        </Stack>
        <Group gap="xs">
          {contest.status === 'draft' && (
            <Button
              size="md"
              loading={pending}
              onClick={() =>
                void run(() => api('POST', `/api/contests/${id}/open`), 'Приём открыт, публикация отправляется')
              }
            >
              Опубликовать и открыть приём
            </Button>
          )}
          {contest.status === 'open' && (
            <Button size="md" loading={pending} onClick={draw}>
              Разыграть сейчас
            </Button>
          )}
          <Menu position="bottom-end">
            <Menu.Target>
              <Button variant="default" size="md" aria-label="Ещё действия">
                ⋯
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {!finished && <Menu.Item onClick={() => setDialog('conditions')}>Изменить условия и даты</Menu.Item>}
              {contest.post && (
                <Menu.Item onClick={() => setDialog('publication')}>Изменить текст и картинку</Menu.Item>
              )}
              {resendable && (
                <Menu.Item
                  onClick={() =>
                    void run(
                      () => api('POST', `/api/contests/${id}/publication/resume`),
                      'Отправка в оставшиеся каналы запущена',
                    )
                  }
                >
                  Отправить в оставшиеся каналы
                </Menu.Item>
              )}
              {contest.status !== 'drawn' && (
                <Menu.Item color="red" onClick={() => void remove()}>
                  Удалить конкурс
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      {notice && (
        <Alert color={notice.color} withCloseButton onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Stat
          label="Участники"
          value={formatCount(contest.participantsCount)}
          hint={contest.participantsLastDay > 0 ? `+${contest.participantsLastDay} за сутки` : undefined}
        />
        <Stat label="Призовых мест" value={String(contest.prizes.length)} />
        <Stat
          label="Розыгрыш"
          value={contest.endsAt ? formatDateTime(contest.endsAt) : 'вручную'}
          hint={contest.status === 'open' && contest.endsAt ? `через ${timeLeft(contest.endsAt)}` : undefined}
        />
        <Stat
          label="Каналы"
          value={`${deliveries.filter((d) => d.status === 'sent').length} / ${deliveries.length}`}
          hint={contest.post?.status === 'draft' ? 'не опубликовано' : 'опубликовано'}
        />
      </SimpleGrid>

      <Tabs value={tab} onChange={(value) => setSearch(value && value !== 'overview' ? { tab: value } : {})}>
        <Tabs.List>
          <Tabs.Tab value="overview">Обзор</Tabs.Tab>
          <Tabs.Tab value="participants">Участники · {formatCount(contest.participantsCount)}</Tabs.Tab>
          <Tabs.Tab value="results">{contest.status === 'drawn' ? 'Итоги' : 'Призы и победители'}</Tabs.Tab>
          {canSeeStats && <Tabs.Tab value="stats">Статистика</Tabs.Tab>}
          <Tabs.Tab value="journal">Журнал</Tabs.Tab>
        </Tabs.List>

        <Box pt="lg">
          {tab === 'overview' && <Overview contest={contest} onEdit={setDialog} />}
          {tab === 'participants' && <ParticipantsTab contest={contest} run={run} />}
          {tab === 'results' && <ResultsTab contest={contest} run={run} />}
          {tab === 'stats' && canSeeStats && <StatsTab contest={contest} />}
          {tab === 'journal' && <JournalTab contest={contest} />}
        </Box>
      </Tabs>

      {dialog === 'conditions' && <ConditionsModal contest={contest} onClose={() => setDialog(null)} />}
      {dialog === 'publication' && <PublicationModal contest={contest} onClose={() => setDialog(null)} />}
      {dialog === 'prizes' && <PrizesModal contest={contest} onClose={() => setDialog(null)} />}
    </Stack>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card withBorder radius="lg" p="md">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="xl">
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Card>
  );
}

function Overview({ contest, onEdit }: { contest: ContestDetails; onEdit: (d: Dialog) => void }) {
  const finished = contest.status === 'drawn' || contest.status === 'cancelled';
  const image = contest.post?.attachments.find((a) => a.kind === 'image');

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
      <Card withBorder radius="lg" p="lg">
        <Group justify="space-between" mb="sm">
          <Title order={2} size="h4">
            Публикация
          </Title>
          {contest.post && (
            <Anchor component="button" onClick={() => onEdit('publication')}>
              Изменить текст
            </Anchor>
          )}
        </Group>
        {contest.post ? (
          <Stack gap="sm">
            {image && <Image src={previewUrl(image.id)} alt="" radius="md" mah={260} fit="contain" />}
            <RichView value={contest.post.text} />
            <Box p="xs" bg="blue.0" ta="center" style={{ borderRadius: 8 }}>
              <Text c="blue.8" fw={600} size="sm">
                {contest.status === 'drawn'
                  ? contest.resultsButtonLabel
                  : `${contest.joinButtonLabel} (${contest.participantsCount})`}
              </Text>
            </Box>
          </Stack>
        ) : (
          <Text c="dimmed">Конкурс без публикации — участники только вручную.</Text>
        )}
      </Card>

      <Stack gap="lg">
        <Card withBorder radius="lg" p="lg">
          <Title order={2} size="h4" mb="sm">
            Каналы
          </Title>
          <Stack gap="xs">
            {contest.post?.deliveries.map((d) => (
              <Group key={d.groupId} justify="space-between" wrap="nowrap">
                <Text>{d.title}</Text>
                <Badge color={DELIVERY[d.status].color} variant="light" title={d.error ?? undefined}>
                  {DELIVERY[d.status].label}
                </Badge>
              </Group>
            ))}
            <Text size="sm" c="dimmed">
              {contest.requiredGroups.length > 0
                ? `Условие: подписка на ${contest.requiredGroups.map((g) => `«${g.title}»`).join(', ')}`
                : 'Без условия подписки'}
            </Text>
          </Stack>
        </Card>

        <Card withBorder radius="lg" p="lg">
          <Group justify="space-between" mb="sm">
            <Title order={2} size="h4">
              Призы
            </Title>
            {!finished && contest.prizesEditable && (
              <Anchor component="button" onClick={() => onEdit('prizes')}>
                Изменить
              </Anchor>
            )}
          </Group>
          {contest.prizes.length === 0 ? (
            <Text c="dimmed">Мест пока нет.</Text>
          ) : (
            <Stack gap={6}>
              {contest.prizes.map((p) => (
                <Group key={p.id} gap="sm" wrap="nowrap">
                  <Badge variant="light" circle>
                    {p.place}
                  </Badge>
                  <Text>{p.label}</Text>
                </Group>
              ))}
            </Stack>
          )}
        </Card>

        <Card withBorder radius="lg" p="lg">
          <Group justify="space-between" mb="sm">
            <Title order={2} size="h4">
              Условия
            </Title>
            {!finished && (
              <Anchor component="button" onClick={() => onEdit('conditions')}>
                Изменить
              </Anchor>
            )}
          </Group>
          <Stack gap={4}>
            <Text size="sm">Публикация и приём: {contest.startsAt ? formatDateTime(contest.startsAt) : 'вручную'}</Text>
            <Text size="sm">Розыгрыш: {contest.endsAt ? formatDateTime(contest.endsAt) : 'вручную, кнопкой'}</Text>
            <Text size="sm">Победителям в личку: {contest.notifyWinners ? 'да' : 'нет'}</Text>
            <Text size="sm">Победители в посте: {contest.publishResultsInPost ? 'да' : 'нет'}</Text>
            <Text size="sm" c="dimmed">
              Кнопки: «{contest.joinButtonLabel}» → «{contest.resultsButtonLabel}» · {contest.prizes.length}{' '}
              {plural(contest.prizes.length, ['место', 'места', 'мест'])}
            </Text>
          </Stack>
        </Card>
      </Stack>
    </SimpleGrid>
  );
}
