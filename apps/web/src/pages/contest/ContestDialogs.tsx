import { useState, type ReactNode } from 'react';
import { ActionIcon, Alert, Button, Checkbox, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { RichText } from '../../RichText';
import { api, type ChannelOption, type ContestDetails, type Media } from '../../api';
import { useChannels } from '../../hooks';
import { toLocalInput } from '../../format';
import { MediaPicker } from '../../MediaPicker';
import { outcomeNotice, useAction, type Notice } from '../../useAction';

interface DialogProps {
  contest: ContestDetails;
  onClose: () => void;
}

/**
 * Окно правки: закрывается само только при полном успехе. Отказ или
 * частичный успех остаются на виду вместе с набранным.
 */
function EditModal({
  title,
  notice,
  pending,
  onClose,
  onSave,
  children,
}: {
  title: string;
  notice: Notice | null;
  pending: boolean;
  onClose: () => void;
  onSave: () => void;
  children: ReactNode;
}) {
  return (
    <Modal opened onClose={onClose} title={title} size="lg" centered>
      <Stack>
        {children}
        {notice && <Alert color={notice.color}>{notice.text}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button loading={pending} onClick={onSave}>
            Сохранить
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

async function saveThenClose(
  run: ReturnType<typeof useAction>['run'],
  action: () => Promise<unknown>,
  onClose: () => void,
  ok: string | ((result: unknown) => Notice),
) {
  let closed = false;
  await run(action, (result) => {
    const notice = typeof ok === 'string' ? { color: 'green' as const, text: ok } : ok(result);
    if (notice.color === 'green') {
      closed = true;
      onClose();
    }
    return notice;
  });
  return closed;
}

export function ConditionsModal({ contest, onClose }: DialogProps) {
  const { run, notice, pending } = useAction(contest.id);
  const channels = useChannels();
  const [title, setTitle] = useState(contest.title);
  const [joinButtonLabel, setJoin] = useState(contest.joinButtonLabel);
  const [resultsButtonLabel, setResults] = useState(contest.resultsButtonLabel);
  const [notifyWinners, setNotify] = useState(contest.notifyWinners);
  const [publishResultsInPost, setPublish] = useState(contest.publishResultsInPost);
  const [startsAt, setStartsAt] = useState(toLocalInput(contest.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalInput(contest.endsAt));
  const [required, setRequired] = useState(contest.requiredGroups.map((g) => g.id));

  // Условие подписки — только на каналы MAX. Неактивные из условия в список
  // выбора не попадают, но и не снимаются молча: показаны отдельно.
  const maxChannels = (channels.data ?? []).filter((c) => c.platform === 'max');
  const inactive = contest.requiredGroups.filter((g) => !maxChannels.some((c) => c.id === g.id));

  const save = () =>
    saveThenClose(
      run,
      () =>
        api('POST', `/api/contests/${contest.id}/conditions`, {
          title,
          joinButtonLabel,
          resultsButtonLabel,
          notifyWinners,
          publishResultsInPost,
          startsAt: startsAt || undefined,
          endsAt: endsAt || undefined,
          requiredGroupIds: required,
        }),
      onClose,
      'Условия сохранены',
    );

  return (
    <EditModal title="Условия и даты" notice={notice} pending={pending} onClose={onClose} onSave={() => void save()}>
      <TextInput label="Название" value={title} onChange={(e) => setTitle(e.currentTarget.value)} required />
      <Group grow>
        <TextInput
          label="Кнопка до розыгрыша"
          value={joinButtonLabel}
          onChange={(e) => setJoin(e.currentTarget.value)}
        />
        <TextInput
          label="Кнопка после"
          value={resultsButtonLabel}
          onChange={(e) => setResults(e.currentTarget.value)}
        />
      </Group>
      <Group grow>
        <TextInput
          type="datetime-local"
          label="Публикация и приём"
          description="Пусто — вручную"
          value={startsAt}
          disabled={contest.status !== 'draft'}
          onChange={(e) => setStartsAt(e.currentTarget.value)}
        />
        <TextInput
          type="datetime-local"
          label="Розыгрыш"
          description="Пусто — вручную, кнопкой"
          value={endsAt}
          onChange={(e) => setEndsAt(e.currentTarget.value)}
        />
      </Group>
      <Checkbox
        label="Написать победителям в личку"
        checked={notifyWinners}
        onChange={(e) => setNotify(e.currentTarget.checked)}
      />
      <Checkbox
        label="Дописать победителей в пост"
        checked={publishResultsInPost}
        onChange={(e) => setPublish(e.currentTarget.checked)}
      />
      <Stack gap={6}>
        <Text fw={500} size="sm">
          Условие: подписка
        </Text>
        <ChannelChecks channels={maxChannels} value={required} onChange={setRequired} />
        {inactive.map((g) => (
          <Text key={g.id} size="sm" c="orange">
            «{g.title}» — канал неактивен, условие остаётся, пока его не снимут здесь:{' '}
            <ActionIcon
              variant="subtle"
              size="xs"
              aria-label={`Снять условие ${g.title}`}
              onClick={() => setRequired(required.filter((x) => x !== g.id))}
            >
              ×
            </ActionIcon>
          </Text>
        ))}
        {required.length === 0 && (
          <Text size="xs" c="dimmed">
            Ничего не отмечено — участвовать может любой, кто нажмёт кнопку.
          </Text>
        )}
      </Stack>
    </EditModal>
  );
}

export function PublicationModal({ contest, onClose }: DialogProps) {
  const { run, notice, pending } = useAction(contest.id);
  const post = contest.post!;
  const draft = post.status === 'draft';
  const channels = useChannels();
  const [text, setText] = useState(post.text);
  const [media, setMedia] = useState<Media[]>(post.attachments);
  const [groupIds, setGroupIds] = useState(post.deliveries.map((d) => d.groupId));

  const save = () =>
    saveThenClose(
      run,
      () =>
        api('POST', `/api/contests/${contest.id}/publication`, {
          text,
          attachmentIds: media.map((m) => m.id),
          groupIds: draft ? groupIds : undefined,
        }),
      onClose,
      (result) => outcomeNotice(result, draft ? 'Публикация сохранена' : 'Обновлено во всех каналах'),
    );

  return (
    <EditModal
      title={draft ? 'Публикация' : 'Изменить опубликованное'}
      notice={notice}
      pending={pending}
      onClose={onClose}
      onSave={() => void save()}
    >
      {!draft && (
        <Text size="sm" c="dimmed">
          Сообщения обновятся во всех каналах, где конкурс уже опубликован.
        </Text>
      )}
      <RichText label="Текст" minRows={6} value={text} onChange={setText} />
      <MediaPicker value={media} onChange={setMedia} />
      {draft && (
        <Stack gap={6}>
          <Text fw={500} size="sm">
            Где опубликовать
          </Text>
          <ChannelChecks
            channels={(channels.data ?? []).filter((c) => c.platform === 'max')}
            value={groupIds}
            onChange={setGroupIds}
          />
        </Stack>
      )}
    </EditModal>
  );
}

export function PrizesModal({ contest, onClose }: DialogProps) {
  const { run, notice, pending } = useAction(contest.id);
  const [labels, setLabels] = useState(contest.prizes.map((p) => p.label));
  const forced = contest.prizes.filter((p) => p.isForced && p.winner).map((p) => p.place);

  const save = () =>
    saveThenClose(
      run,
      () =>
        api('POST', `/api/contests/${contest.id}/prizes`, {
          prizes: labels.map((l) => l.trim()),
        }),
      onClose,
      'Призы сохранены',
    );

  return (
    <EditModal title="Призовые места" notice={notice} pending={pending} onClose={onClose} onSave={() => void save()}>
      <PrizeList value={labels} onChange={setLabels} />
      {forced.length > 0 && (
        <Alert color="orange">
          Закреплённые места ({forced.join(', ')}) после сохранения открепятся — список мест создаётся заново.
        </Alert>
      )}
    </EditModal>
  );
}

export function PrizeList({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  return (
    <Stack gap="xs">
      {value.map((label, index) => (
        <Group key={index} gap="xs" wrap="nowrap">
          <Text w={24} ta="right" fw={600}>
            {index + 1}
          </Text>
          <TextInput
            style={{ flex: 1 }}
            aria-label={`Приз за ${index + 1} место`}
            placeholder="Что получит победитель"
            value={label}
            onChange={(e) => onChange(value.map((l, i) => (i === index ? e.currentTarget.value : l)))}
          />
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`Убрать ${index + 1} место`}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            ×
          </ActionIcon>
        </Group>
      ))}
      <Button variant="subtle" onClick={() => onChange([...value, ''])} style={{ alignSelf: 'flex-start' }}>
        + Добавить место
      </Button>
    </Stack>
  );
}

export function ChannelChecks({
  channels,
  value,
  onChange,
}: {
  channels: ChannelOption[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  if (channels.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Нет активных каналов MAX.
      </Text>
    );
  }
  return (
    <Stack gap={6}>
      {channels.map((c) => (
        <Checkbox
          key={c.id}
          label={c.title}
          description={c.kind === 'chat' ? 'чат MAX' : 'канал MAX'}
          checked={value.includes(c.id)}
          onChange={(e) => onChange(e.currentTarget.checked ? [...value, c.id] : value.filter((id) => id !== c.id))}
        />
      ))}
    </Stack>
  );
}
