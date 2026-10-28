import { useState, type ReactNode } from 'react';
import {
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Image,
  Radio,
  SimpleGrid,
  Stack,
  Stepper,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { RichText } from '../RichText';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { api, ApiError, previewUrl, type Media } from '../api';
import { formatDateTime, fromLocalInput, plural } from '../format';
import { MediaPicker } from '../MediaPicker';
import { useChannels } from '../hooks';
import type { Notice } from '../useAction';
import { ChannelChecks, PrizeList } from './contest/ContestDialogs';

export function NewContestPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const channels = useChannels();
  const maxChannels = (channels.data ?? []).filter((c) => c.platform === 'max');

  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [media, setMedia] = useState<Media[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [required, setRequired] = useState<string[]>([]);
  const [prizes, setPrizes] = useState<string[]>(['']);
  const [publishMode, setPublishMode] = useState<'now' | 'scheduled'>('now');
  const [startsAt, setStartsAt] = useState('');
  const [drawMode, setDrawMode] = useState<'auto' | 'manual'>('auto');
  const [endsAt, setEndsAt] = useState('');
  const [notifyWinners, setNotify] = useState(true);
  const [publishResultsInPost, setPublishResults] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const cleanPrizes = prizes.map((p) => p.trim()).filter(Boolean);

  // Проверки шага — до перехода дальше, чтобы человек не узнал о пустом
  // поле только на последнем экране.
  const stepError = [
    () => (!title.trim() ? 'Впишите название' : !text.trim() ? 'Впишите текст — его увидят подписчики' : null),
    () => (groupIds.length === 0 ? 'Отметьте хотя бы один канал' : null),
    () => {
      if (prizes.some((p) => !p.trim())) return 'Заполните или уберите пустые места';
      if (publishMode === 'scheduled' && !startsAt) return 'Укажите время публикации';
      if (drawMode === 'auto' && !endsAt) return 'Укажите время розыгрыша';
      if (drawMode === 'auto' && cleanPrizes.length === 0) return 'Для розыгрыша по дате нужно хотя бы одно место';
      if (drawMode === 'auto' && publishMode === 'scheduled' && startsAt >= endsAt)
        return 'Розыгрыш должен быть позже публикации';
      return null;
    },
  ];

  const next = () => {
    const message = stepError[step]?.();
    setError(message);
    if (!message) setStep(step + 1);
  };

  const submit = async (mode: 'draft' | 'publish') => {
    setPending(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>('POST', '/api/contests', {
        title,
        text,
        attachmentIds: media.map((m) => m.id),
        groupIds,
        requiredGroupIds: required,
        prizes: cleanPrizes,
        notifyWinners,
        publishResultsInPost,
        // Черновик не публикуется сам: дата начала — только у запланированного.
        startsAt: mode === 'publish' && publishMode === 'scheduled' ? startsAt : undefined,
        endsAt: drawMode === 'auto' ? endsAt : undefined,
      });
      // Конкурс уже создан: отказ публикации показывается на его карточке.
      let notice: Notice | undefined;
      if (mode === 'publish' && publishMode === 'now') {
        await api('POST', `/api/contests/${id}/open`).catch((err) => {
          notice = {
            color: 'red',
            text: `Конкурс сохранён черновиком, опубликовать не удалось: ${err instanceof ApiError ? err.message : 'ошибка сети'}`,
          };
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['contests'] });
      navigate(`/contests/${id}`, { state: { notice } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать конкурс');
    } finally {
      setPending(false);
    }
  };

  const channelTitles = maxChannels.filter((c) => groupIds.includes(c.id)).map((c) => c.title);
  const requiredTitles = maxChannels.filter((c) => required.includes(c.id)).map((c) => `«${c.title}»`);
  const image = media.find((m) => m.kind === 'image');

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Stack gap={4}>
        <Anchor component={Link} to="/contests" size="sm">
          ← Конкурсы
        </Anchor>
        <Title order={1} size="h2">
          Новый конкурс
        </Title>
      </Stack>

      <Stepper active={step} onStepClick={(s) => s < step && setStep(s)} size="sm">
        <Stepper.Step label="Текст и картинка" />
        <Stepper.Step label="Каналы и условия" />
        <Stepper.Step label="Призы и даты" />
        <Stepper.Step label="Проверка" />
      </Stepper>

      {error && <Alert color="red">{error}</Alert>}

      {step === 0 && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          <Stack>
            <TextInput
              label="Название"
              description="Видно только в панели"
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
            />
            <RichText
              label="Текст конкурса"

              minRows={8}
              value={text}
              onChange={setText}
            />
            <Stack gap={4}>
              <Text fw={500} size="sm">
                Картинка или видео
              </Text>
              <MediaPicker value={media} onChange={setMedia} />
            </Stack>
          </Stack>
          <Preview image={image?.id} text={text} />
        </SimpleGrid>
      )}

      {step === 1 && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          <Section title="Где опубликовать" hint="Хотя бы один канал. Только MAX — в VK у постов нет кнопок.">
            <ChannelChecks channels={maxChannels} value={groupIds} onChange={setGroupIds} />
          </Section>
          <Section
            title="Условие: подписка"
            hint="Участвует только подписанный. Отписавшихся до розыгрыша бот исключит сам."
          >
            <ChannelChecks channels={maxChannels} value={required} onChange={setRequired} />
            {required.length === 0 && (
              <Text size="xs" c="dimmed">
                Ничего не отмечено — участвовать может любой, кто нажмёт кнопку.
              </Text>
            )}
          </Section>
        </SimpleGrid>
      )}

      {step === 2 && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          <Section title="Призовые места">
            <PrizeList value={prizes} onChange={setPrizes} />
          </Section>
          <Section title="Когда">
            <Radio.Group
              label="Публикация и приём участников"
              value={publishMode}
              onChange={(v) => setPublishMode(v as 'now' | 'scheduled')}
            >
              <Stack gap="xs" mt="xs">
                <Radio value="now" label="Сразу после проверки" />
                <Radio value="scheduled" label="Запланировать на" />
                {publishMode === 'scheduled' && (
                  <TextInput
                    type="datetime-local"
                    aria-label="Время публикации"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.currentTarget.value)}
                  />
                )}
              </Stack>
            </Radio.Group>
            <Radio.Group label="Розыгрыш" value={drawMode} onChange={(v) => setDrawMode(v as 'auto' | 'manual')}>
              <Stack gap="xs" mt="xs">
                <Radio value="auto" label="Автоматически" />
                {drawMode === 'auto' && (
                  <TextInput
                    type="datetime-local"
                    aria-label="Время розыгрыша"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.currentTarget.value)}
                  />
                )}
                <Radio value="manual" label="Вручную, кнопкой в карточке" />
              </Stack>
            </Radio.Group>
            <Checkbox
              label="Написать победителям в личку"
              checked={notifyWinners}
              onChange={(e) => setNotify(e.currentTarget.checked)}
            />
            <Checkbox
              label="Дописать победителей в пост"
              checked={publishResultsInPost}
              onChange={(e) => setPublishResults(e.currentTarget.checked)}
            />
          </Section>
        </SimpleGrid>
      )}

      {step === 3 && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          <Stack>
            <ReviewRow title="Название и текст" onEdit={() => setStep(0)}>
              <Text fw={600}>{title}</Text>
              <Text size="sm" c="dimmed">
                {text.split(/\n\s*\n/).filter(Boolean).length} абз. · {media.length}{' '}
                {plural(media.length, ['вложение', 'вложения', 'вложений'])}
              </Text>
            </ReviewRow>
            <ReviewRow title="Каналы и условие" onEdit={() => setStep(1)}>
              <Text>{channelTitles.join(', ')}</Text>
              <Text size="sm" c="dimmed">
                {requiredTitles.length > 0 ? `Нужна подписка на ${requiredTitles.join(', ')}` : 'Без условия подписки'}
              </Text>
            </ReviewRow>
            <ReviewRow title="Призы и даты" onEdit={() => setStep(2)}>
              <Text>
                {cleanPrizes.length > 0
                  ? `${cleanPrizes.length} ${plural(cleanPrizes.length, ['место', 'места', 'мест'])}: ${cleanPrizes.join(', ')}`
                  : 'Мест нет'}
              </Text>
              <Text size="sm" c="dimmed">
                {publishMode === 'scheduled' && startsAt
                  ? `Публикация ${formatDateTime(fromLocalInput(startsAt))}`
                  : 'Публикация сразу'}
                {' · '}
                {drawMode === 'auto' && endsAt ? `розыгрыш ${formatDateTime(fromLocalInput(endsAt))}` : 'розыгрыш вручную'}
                {notifyWinners ? ' · победителям в личку' : ''}
              </Text>
            </ReviewRow>
            <Text size="sm" c="dimmed">
              До публикации можно поменять всё. После — только текст, картинку, призы и дату розыгрыша.
            </Text>
          </Stack>
          <Preview image={image?.id} text={text} />
        </SimpleGrid>
      )}

      <Group justify="space-between">
        {step === 0 ? (
          <Button variant="default" component={Link} to="/contests">
            Отмена
          </Button>
        ) : (
          <Button variant="default" onClick={() => setStep(step - 1)}>
            ← Назад
          </Button>
        )}
        {step < 3 ? (
          <Button onClick={next}>Далее →</Button>
        ) : (
          <Group gap="xs">
            <Button variant="default" loading={pending} onClick={() => void submit('draft')}>
              Сохранить черновик
            </Button>
            <Button loading={pending} onClick={() => void submit('publish')}>
              {publishMode === 'scheduled' && startsAt
                ? `Запланировать на ${formatDateTime(fromLocalInput(startsAt))}`
                : 'Опубликовать сейчас'}
            </Button>
          </Group>
        )}
      </Group>
    </Stack>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card withBorder radius="lg" p="lg">
      <Stack gap="sm">
        <div>
          <Title order={2} size="h4">
            {title}
          </Title>
          {hint && (
            <Text size="sm" c="dimmed">
              {hint}
            </Text>
          )}
        </div>
        {children}
      </Stack>
    </Card>
  );
}

function ReviewRow({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <Card withBorder radius="lg" p="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={2}>
          <Text size="sm" c="dimmed">
            {title}
          </Text>
          {children}
        </Stack>
        <Anchor component="button" onClick={onEdit}>
          Изменить
        </Anchor>
      </Group>
    </Card>
  );
}

function Preview({ image, text }: { image?: string; text: string }) {
  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        Как увидят в MAX
      </Text>
      <Card withBorder radius="lg" p="md" bg="gray.0">
        <Stack gap="sm">
          {image && <Image src={previewUrl(image)} alt="" radius="md" mah={240} fit="contain" />}
          <Text style={{ whiteSpace: 'pre-wrap' }}>{text || 'Текст конкурса'}</Text>
          <Box p="xs" bg="blue.0" ta="center" style={{ borderRadius: 8 }}>
            <Text c="blue.8" fw={600} size="sm">
              Участвовать
            </Text>
          </Box>
        </Stack>
      </Card>
    </Stack>
  );
}
