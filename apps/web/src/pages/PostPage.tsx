import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Checkbox,
  Group,
  Image,
  Loader,
  Modal,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { postFirstLine, RichText, RichView } from '../RichText';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { api, previewUrl, type Media, type ModerationOutcome, type PostDetails } from '../api';
import { DELIVERY } from '../contestLabels';
import { DmTarget, dmTargetReady, type DmTargetValue } from '../DmTarget';
import { formatDateTime, toLocalInput } from '../format';
import { useChannels, useMe } from '../hooks';
import { MediaPicker } from '../MediaPicker';
import { AutoDelete, draftPayload, POST_STATUS, PostFields, type PostDraft } from '../PostFields';
import { outcomeNotice, useAction, type Notice } from '../useAction';

type Dialog = 'draft' | 'published' | 'delete' | null;

export function PostPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const sendError = (location.state as { sendError?: string | null } | null)?.sendError ?? null;
  const [dialog, setDialog] = useState<Dialog>(null);
  const { run, notice, setNotice, pending } = useAction(id, postKeys(id));
  const query = useQuery({
    queryKey: ['post', id],
    queryFn: () => api<PostDetails | { contestId: string }>('GET', `/api/posts/${id}`),
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
        <Anchor component={Link} to="/posts">
          ← Посты
        </Anchor>
        <Alert color="red">{query.error.message}</Alert>
      </Stack>
    );
  }
  if (query.data.contestId) {
    // Носитель конкурса — всё про него в карточке конкурса.
    return <Navigate to={`/contests/${query.data.contestId}`} replace />;
  }

  const post = query.data as PostDetails;
  const status = POST_STATUS[post.status];
  const published = post.deliveries.filter((d) => d.published);
  const act = (path: string, ok: string) => void run(() => api('POST', `/api/posts/${id}/${path}`), ok);
  const image = post.attachments.find((a) => a.kind === 'image');

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Group justify="space-between" align="flex-start">
        <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
          <Anchor component={Link} to="/posts" size="sm">
            ← Посты
          </Anchor>
          <Group gap="sm">
            <Title order={1} size="h3" style={{ overflowWrap: 'anywhere' }}>
              {postFirstLine(post.text)}
            </Title>
            <Badge color={status.color} variant="light" radius="xl">
              {status.label}
            </Badge>
          </Group>
        </Stack>
        <Group gap="xs">
          {post.status === 'draft' && (
            <>
              <Button variant="default" onClick={() => setDialog('draft')}>
                Изменить
              </Button>
              <Button
                loading={pending}
                onClick={() => act('send', post.scheduledAt ? 'Запланировано' : 'Отправка запущена')}
              >
                {post.scheduledAt ? `Запланировать на ${formatDateTime(post.scheduledAt)}` : 'Отправить'}
              </Button>
            </>
          )}
          {(post.status === 'scheduled' || post.status === 'sending') && (
            <Button color="red" variant="light" loading={pending} onClick={() => act('stop', 'Рассылка остановлена')}>
              Остановить
            </Button>
          )}
          {post.deliveries.some((d) => d.status === 'failed') && (
            <Button loading={pending} onClick={() => act('resume', 'Отправка в оставшиеся каналы запущена')}>
              Отправить оставшимся
            </Button>
          )}
          {published.length > 0 && (
            <>
              <Button variant="default" onClick={() => setDialog('published')}>
                Изменить опубликованное
              </Button>
              <Button variant="default" color="red" onClick={() => setDialog('delete')}>
                Снять из каналов
              </Button>
            </>
          )}
        </Group>
      </Group>

      {sendError && <Alert color="orange">Пост сохранён черновиком, но не отправлен: {sendError}</Alert>}
      {notice && (
        <Alert color={notice.color} withCloseButton onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Card withBorder radius="lg" p="lg">
          <Stack gap="sm">
            {image && <Image src={previewUrl(image.id)} alt="" radius="md" mah={260} fit="contain" />}
            <RichView value={post.text} />
            {post.maxTextOverride && (
              <Stack gap={2}>
                <Text size="sm" c="dimmed">
                  Для MAX:
                </Text>
                <RichView value={post.maxTextOverride} />
              </Stack>
            )}
            {post.vkTextOverride && (
              <Stack gap={2}>
                <Text size="sm" c="dimmed">
                  Для VK:
                </Text>
                <RichView value={post.vkTextOverride} />
              </Stack>
            )}
            <Text size="xs" c="dimmed">
              Создан {formatDateTime(post.createdAt)}
              {post.scheduledAt ? ` · отправка ${formatDateTime(post.scheduledAt)}` : ''}
              {post.autoDeleteAfterMinutes
                ? ` · удалится через ${Math.round(post.autoDeleteAfterMinutes / 60)} ч после публикации`
                : ''}
            </Text>
          </Stack>
        </Card>

        <Card withBorder radius="lg" p="lg">
          <Title order={2} size="h4" mb="sm">
            Каналы
          </Title>
          <Table.ScrollContainer minWidth={360}>
            <Table>
              <Table.Tbody>
                {post.deliveries.map((d) => (
                  <Table.Tr key={d.groupId}>
                    <Table.Td>
                      <Text size="sm">{d.title}</Text>
                      <Text size="xs" c="dimmed">
                        {d.platform.toUpperCase()}
                        {d.sentAt ? ` · ${formatDateTime(d.sentAt)}` : ''}
                        {d.deletedAt ? ` · снят ${formatDateTime(d.deletedAt)}` : ''}
                        {!d.deletedAt && d.autoDeleteDueAt ? ` · удалится ${formatDateTime(d.autoDeleteDueAt)}` : ''}
                      </Text>
                      {d.error && (
                        <Text size="xs" c="red">
                          {d.error}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      <Badge color={d.deletedAt ? 'gray' : DELIVERY[d.status].color} variant="light">
                        {d.deletedAt ? 'снят' : DELIVERY[d.status].label}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      </SimpleGrid>

      <DirectMessagesCard post={post} />

      {dialog === 'draft' && <EditDraftModal post={post} onClose={() => setDialog(null)} />}
      {dialog === 'published' && <EditPublishedModal post={post} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteModal post={post} onClose={() => setDialog(null)} />}
    </Stack>
  );
}

interface ModalProps {
  post: PostDetails;
  onClose: () => void;
}

function postKeys(id: string): unknown[][] {
  return [['post', id], ['posts']];
}

function draftFrom(post: PostDetails): PostDraft {
  return {
    text: post.text,
    vkTextOverride: post.vkTextOverride ?? '',
    maxTextOverride: post.maxTextOverride ?? '',
    attachments: post.attachments,
    groupIds: post.deliveries.map((d) => d.groupId),
    scheduledAt: toLocalInput(post.scheduledAt),
    autoDeleteAfterMinutes: post.autoDeleteAfterMinutes,
  };
}

function SaveFooter({
  notice,
  pending,
  onClose,
  onSave,
  label = 'Сохранить',
}: {
  notice: Notice | null;
  pending: boolean;
  onClose: () => void;
  onSave: () => void;
  label?: string;
}) {
  return (
    <>
      {notice && <Alert color={notice.color}>{notice.text}</Alert>}
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Отмена
        </Button>
        <Button loading={pending} onClick={onSave}>
          {label}
        </Button>
      </Group>
    </>
  );
}

/** Закрывается само только при полном успехе — иначе причина видна вместе с набранным. */
async function saveAndClose(
  run: ReturnType<typeof useAction>['run'],
  action: () => Promise<unknown>,
  ok: (result: unknown) => Notice,
  onClose: () => void,
) {
  await run(action, (result) => {
    const n = ok(result);
    if (n.color === 'green') onClose();
    return n;
  });
}

function EditDraftModal({ post, onClose }: ModalProps) {
  const { run, notice, pending } = useAction(post.id, postKeys(post.id));
  const channels = useChannels();
  const [draft, setDraft] = useState(() => draftFrom(post));
  return (
    <Modal opened onClose={onClose} title="Черновик" size="xl" centered>
      <Stack>
        <PostFields value={draft} onChange={setDraft} channels={channels.data ?? []} />
        <SaveFooter
          notice={notice}
          pending={pending}
          onClose={onClose}
          onSave={() =>
            void saveAndClose(
              run,
              () => api('POST', `/api/posts/${post.id}/draft`, draftPayload(draft)),
              () => ({ color: 'green', text: 'Черновик сохранён' }),
              onClose,
            )
          }
        />
      </Stack>
    </Modal>
  );
}

function EditPublishedModal({ post, onClose }: ModalProps) {
  const { run, notice, pending } = useAction(post.id, postKeys(post.id));
  const me = useMe();
  const [text, setText] = useState(post.text);
  const [maxText, setMaxText] = useState(post.maxTextOverride ?? '');
  const [vkText, setVkText] = useState(post.vkTextOverride ?? '');
  const [media, setMedia] = useState<Media[]>(post.attachments);
  const [autoDelete, setAutoDelete] = useState(post.autoDeleteAfterMinutes);
  const showVk = me.data?.role === 'developer' && post.deliveries.some((d) => d.platform === 'vk');

  return (
    <Modal opened onClose={onClose} title="Изменить опубликованное" size="lg" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          Сообщения обновятся во всех каналах, где пост вышел и не снят.
        </Text>
        <RichText label="Текст" minRows={5} value={text} onChange={setText} />
        <RichText
          label="Текст для MAX"
          description="Пусто — общий текст"

          minRows={2}
          value={maxText}
          onChange={setMaxText}
        />
        {showVk && (
          <RichText
            label="Текст для VK"
            description="Пусто — общий текст"

            minRows={2}
            value={vkText}
            onChange={setVkText}
          />
        )}
        <MediaPicker value={media} onChange={setMedia} />
        <AutoDelete value={autoDelete} onChange={setAutoDelete} />
        <SaveFooter
          notice={notice}
          pending={pending}
          onClose={onClose}
          label="Сохранить и обновить везде"
          onSave={() =>
            void saveAndClose(
              run,
              () =>
                api('POST', `/api/posts/${post.id}/published`, {
                  text,
                  maxTextOverride: maxText,
                  vkTextOverride: vkText,
                  attachmentIds: media.map((m) => m.id),
                  autoDeleteAfterMinutes: autoDelete,
                }),
              (result) => outcomeNotice(result, 'Обновлено во всех каналах'),
              onClose,
            )
          }
        />
      </Stack>
    </Modal>
  );
}

function DeleteModal({ post, onClose }: ModalProps) {
  const { run, notice, pending } = useAction(post.id, postKeys(post.id));
  const published = post.deliveries.filter((d) => d.published);
  const [groupIds, setGroupIds] = useState(published.map((d) => d.groupId));

  return (
    <Modal opened onClose={onClose} title="Снять из каналов" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          Сообщения будут удалены из отмеченных каналов. Вернуть их нельзя.
        </Text>
        {published.map((d) => (
          <Checkbox
            key={d.groupId}
            label={`${d.title} (${d.platform.toUpperCase()})`}
            checked={groupIds.includes(d.groupId)}
            onChange={(e) =>
              setGroupIds(e.currentTarget.checked ? [...groupIds, d.groupId] : groupIds.filter((g) => g !== d.groupId))
            }
          />
        ))}
        <SaveFooter
          notice={notice}
          pending={pending}
          onClose={onClose}
          label={`Снять из ${groupIds.length}`}
          onSave={() =>
            groupIds.length > 0 &&
            void saveAndClose(
              run,
              () => api<{ outcome: ModerationOutcome }>('POST', `/api/posts/${post.id}/delete-published`, { groupIds }),
              (result) => outcomeNotice(result, 'Снято из выбранных каналов'),
              onClose,
            )
          }
        />
      </Stack>
    </Modal>
  );
}

const DM_LABEL: Record<string, string> = {
  pending: 'в очереди',
  sending: 'отправляется',
  sent: 'доставлено',
  failed: 'ошибка',
  manual_required: 'недоставимо',
};

function DirectMessagesCard({ post }: { post: PostDetails }) {
  const { run, notice, pending } = useAction(post.id, postKeys(post.id));
  const [target, setTarget] = useState<DmTargetValue>({
    mode: 'user',
    platformUserId: null,
  });
  const counts = Object.entries(post.directMessages);

  return (
    <Card withBorder radius="lg" p="lg">
      <Stack>
        <Title order={2} size="h4">
          Разослать в личку
        </Title>
        {counts.length > 0 && (
          <Text size="sm" c="dimmed">
            Уже: {counts.map(([s, n]) => `${DM_LABEL[s] ?? s} ${n}`).join(' · ')}
          </Text>
        )}
        <DmTarget value={target} onChange={setTarget} />
        {notice && <Alert color={notice.color}>{notice.text}</Alert>}
        <Button
          style={{ alignSelf: 'flex-start' }}
          loading={pending}
          disabled={!dmTargetReady(target)}
          onClick={() =>
            void run(
              () => api<{ queued: number }>('POST', `/api/posts/${post.id}/direct-messages`, target),
              (r) => ({
                color: 'green',
                text: `Поставлено в очередь: ${(r as { queued: number }).queued}`,
              }),
            )
          }
        >
          Разослать
        </Button>
      </Stack>
    </Card>
  );
}
