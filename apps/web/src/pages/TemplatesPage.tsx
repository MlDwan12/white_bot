import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { postFirstLine, RichText } from '../RichText';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, type Media } from '../api';
import { formatDateTime, plural } from '../format';
import { useChannels, useMe } from '../hooks';
import { MediaPicker } from '../MediaPicker';
import { ChannelPicker, POST_STATUS } from '../PostFields';
import { useAction } from '../useAction';
import type { TemplateState, Schedule, TemplateSummary, TemplateDetails } from '@white-bot/shared';

const STATE: Record<TemplateState, { label: string; color: string; hint: string }> = {
  running: { label: 'работает', color: 'green', hint: '' },
  paused: { label: 'на паузе', color: 'gray', hint: 'Не отправляется' },
  disarmed: {
    label: 'остановлен',
    color: 'red',
    hint: 'Расписание не разобралось — сохраните заново',
  },
  no_targets: {
    label: 'нет каналов',
    color: 'orange',
    hint: 'Ни один канал не работает',
  },
};

const WEEKDAYS = [
  { value: '1', label: 'понедельник' },
  { value: '2', label: 'вторник' },
  { value: '3', label: 'среда' },
  { value: '4', label: 'четверг' },
  { value: '5', label: 'пятница' },
  { value: '6', label: 'суббота' },
  { value: '0', label: 'воскресенье' },
];

const KEYS: unknown[][] = [['templates'], ['template']];

export function TemplatesPage() {
  const query = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateSummary[]>('GET', '/api/templates'),
  });
  const { run, notice, setNotice } = useAction('', KEYS);

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Group justify="space-between">
        <Stack gap={2}>
          <Title order={1} size="h2">
            Повторяющиеся посты
          </Title>
          <Text c="dimmed" size="sm">
            Уходят сами по расписанию — например, каждое утро.
          </Text>
        </Stack>
        <Button size="md" component={Link} to="/templates/new">
          + Новое расписание
        </Button>
      </Group>
      {notice && (
        <Alert color={notice.color} withCloseButton onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}
      {query.isPending && (
        <Center py="xl">
          <Loader />
        </Center>
      )}
      {query.isError && <Alert color="red">{query.error.message}</Alert>}
      {query.isSuccess && query.data.length === 0 && (
        <Text c="dimmed" ta="center" py="xl">
          Расписаний пока нет.
        </Text>
      )}
      <Stack gap="sm">
        {query.data?.map((t) => {
          const state = STATE[t.state];
          const paused = t.state === 'paused';
          return (
            <Card key={t.id} withBorder radius="lg" p="md">
              <Group justify="space-between" wrap="wrap" gap="sm">
                <Stack gap={4} style={{ flex: '1 1 300px', minWidth: 0 }}>
                  <Group gap="xs">
                    <Text fw={600} truncate component={Link} to={`/templates/${t.id}`} c="inherit">
                      {postFirstLine(t.text)}
                    </Text>
                    <Badge color={state.color} variant="light" radius="xl">
                      {state.label}
                    </Badge>
                  </Group>
                  <Text size="sm">{capitalize(t.scheduleText)}</Text>
                  <Text size="sm" c="dimmed">
                    {t.state === 'running' && t.nextRunAt ? `Следующий: ${formatDateTime(t.nextRunAt)}` : state.hint} ·{' '}
                    {t.targetsCount} {plural(t.targetsCount, ['канал', 'канала', 'каналов'])}
                  </Text>
                </Stack>
                <Group gap="xs">
                  <Button
                    variant="default"
                    size="xs"
                    onClick={() =>
                      void run(
                        () => api('POST', `/api/templates/${t.id}/${paused ? 'resume' : 'pause'}`),
                        paused ? 'Возобновлено' : 'Поставлено на паузу',
                      )
                    }
                  >
                    {paused ? 'Возобновить' : 'Пауза'}
                  </Button>
                  <Button variant="default" size="xs" component={Link} to={`/templates/${t.id}`}>
                    Изменить
                  </Button>
                </Group>
              </Group>
            </Card>
          );
        })}
      </Stack>
    </Stack>
  );
}

interface FormState {
  text: string;
  vkTextOverride: string;
  maxTextOverride: string;
  schedule: Schedule;
  groupIds: string[];
  attachments: Media[];
}

const EMPTY: FormState = {
  text: '',
  vkTextOverride: '',
  maxTextOverride: '',
  schedule: {
    mode: 'daily',
    time: '09:00',
    weekday: 1,
    monthday: 1,
    custom: '',
  },
  groupIds: [],
  attachments: [],
};

/** Новое расписание и правка существующего — одна страница. */
export function TemplatePage() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: ['template', id],
    queryFn: () => api<TemplateDetails>('GET', `/api/templates/${id}`),
    enabled: Boolean(id),
  });
  if (id && query.isPending) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (id && query.isError) return <Alert color="red">{query.error.message}</Alert>;
  // key: после сохранения форма собирается заново из свежих данных.
  return <TemplateForm key={query.dataUpdatedAt} template={id ? query.data! : null} />;
}

function TemplateForm({ template }: { template: TemplateDetails | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const channels = useChannels();
  const me = useMe();
  const isDev = me.data?.role === 'developer';
  const [form, setForm] = useState<FormState>(
    template
      ? {
          text: template.text,
          vkTextOverride: template.vkTextOverride ?? '',
          maxTextOverride: template.maxTextOverride ?? '',
          schedule: template.schedule,
          groupIds: template.targets.map((t) => t.id),
          attachments: template.attachments,
        }
      : EMPTY,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = <K extends keyof FormState>(key: K, v: FormState[K]) => setForm({ ...form, [key]: v });
  const setSchedule = (patch: Partial<Schedule>) => set('schedule', { ...form.schedule, ...patch });
  // Неактивные цели в список выбора не попадают, но и не снимаются молча.
  const inactive = (template?.targets ?? []).filter((t) => !(channels.data ?? []).some((c) => c.id === t.id));

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const body = {
        text: form.text,
        vkTextOverride: form.vkTextOverride,
        maxTextOverride: form.maxTextOverride,
        schedule: form.schedule,
        groupIds: form.groupIds,
        attachmentIds: form.attachments.map((m) => m.id),
      };
      if (template) {
        await api('POST', `/api/templates/${template.id}`, body);
        await queryClient.invalidateQueries({
          queryKey: ['template', template.id],
        });
      } else {
        const { id } = await api<{ id: string }>('POST', '/api/templates', body);
        navigate(`/templates/${id}`);
      }
      await queryClient.invalidateQueries({ queryKey: ['templates'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setPending(false);
    }
  };

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Stack gap={4}>
        <Anchor component={Link} to="/templates" size="sm">
          ← Повторяющиеся
        </Anchor>
        <Group gap="sm">
          <Title order={1} size="h2">
            {template ? 'Расписание' : 'Новое расписание'}
          </Title>
          {template && (
            <Badge color={STATE[template.state].color} variant="light" radius="xl">
              {STATE[template.state].label}
            </Badge>
          )}
        </Group>
        {template?.nextRunAt && template.state === 'running' && (
          <Text c="dimmed" size="sm">
            Следующий запуск: {formatDateTime(template.nextRunAt)}
          </Text>
        )}
      </Stack>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Stack>
          <RichText label="Текст" minRows={6} value={form.text} onChange={(v) => set('text', v)} />
          <RichText
            label="Текст для MAX"
            description="Пусто — общий текст"

            minRows={2}
            value={form.maxTextOverride}
            onChange={(v) => set('maxTextOverride', v)}
          />
          {isDev && (
            <RichText
              label="Текст для VK"
              description="Пусто — общий текст"

              minRows={2}
              value={form.vkTextOverride}
              onChange={(v) => set('vkTextOverride', v)}
            />
          )}
          <MediaPicker value={form.attachments} onChange={(v) => set('attachments', v)} />
        </Stack>
        <Stack>
          <Card withBorder radius="lg" p="lg">
            <Stack>
              <Title order={2} size="h4">
                Когда
              </Title>
              <SegmentedControl
                value={form.schedule.mode}
                onChange={(mode) => setSchedule({ mode: mode as Schedule['mode'] })}
                data={[
                  { value: 'daily', label: 'Каждый день' },
                  { value: 'weekly', label: 'Раз в неделю' },
                  { value: 'monthly', label: 'Раз в месяц' },
                  ...(isDev || form.schedule.mode === 'custom' ? [{ value: 'custom', label: 'cron' }] : []),
                ]}
              />
              {form.schedule.mode === 'custom' ? (
                <TextInput
                  label="cron-выражение"
                  description="Минута час день месяц день-недели, по Москве"
                  value={form.schedule.custom}
                  onChange={(e) => setSchedule({ custom: e.currentTarget.value })}
                />
              ) : (
                <Group grow>
                  {form.schedule.mode === 'weekly' && (
                    <Select
                      label="День"
                      data={WEEKDAYS}
                      value={String(form.schedule.weekday)}
                      onChange={(v) => setSchedule({ weekday: Number(v ?? 1) })}
                    />
                  )}
                  {form.schedule.mode === 'monthly' && (
                    <NumberInput
                      label="Число"
                      description="С 1 по 28 — чтобы не пропускать короткие месяцы"
                      min={1}
                      max={28}
                      value={form.schedule.monthday}
                      onChange={(v) => setSchedule({ monthday: Number(v) || 1 })}
                    />
                  )}
                  <TextInput
                    type="time"
                    label="Время"
                    value={form.schedule.time}
                    onChange={(e) => setSchedule({ time: e.currentTarget.value })}
                  />
                </Group>
              )}
            </Stack>
          </Card>
          <Card withBorder radius="lg" p="lg">
            <Title order={2} size="h4" mb="sm">
              Куда
            </Title>
            <ChannelPicker channels={channels.data ?? []} value={form.groupIds} onChange={(v) => set('groupIds', v)} />
            {inactive.map((t) => (
              <Text key={t.id} size="sm" c="orange" mt="xs">
                «{t.title}» сейчас не работает — пропускается, пока не восстановится.
              </Text>
            ))}
          </Card>
        </Stack>
      </SimpleGrid>

      {error && <Alert color="red">{error}</Alert>}
      <Group justify="flex-end">
        <Button size="md" loading={pending} onClick={() => void save()}>
          {template ? 'Сохранить' : 'Создать'}
        </Button>
      </Group>

      {template && template.occurrences.length > 0 && (
        <Card withBorder radius="lg" p="lg">
          <Title order={2} size="h4" mb="sm">
            Последние отправки
          </Title>
          <Stack gap={6}>
            {template.occurrences.map((o) => (
              <Group key={o.id} justify="space-between">
                <Anchor component={Link} to={`/posts/${o.id}`} size="sm">
                  {formatDateTime(o.createdAt)}
                </Anchor>
                <Badge color={POST_STATUS[o.status].color} variant="light">
                  {POST_STATUS[o.status].label}
                </Badge>
              </Group>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
