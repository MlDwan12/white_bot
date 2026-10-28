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
  Modal,
  PasswordInput,
  Stack,
  Table,
  TagsInput,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { api, openWithSession } from '../api';
import { formatDateTime } from '../format';
import { useMe } from '../hooks';
import { useAction, type Notice } from '../useAction';
import type { GroupStatus, GroupRow, GroupsData } from '@white-bot/shared';

const STATUS: Record<GroupStatus, { label: string; color: string }> = {
  pending_confirmation: { label: 'ждёт подтверждения', color: 'yellow' },
  active: { label: 'работает', color: 'green' },
  token_invalid: { label: 'токен не работает', color: 'red' },
  bot_removed: { label: 'бота удалили', color: 'gray' },
  removed: { label: 'отключён', color: 'gray' },
};

const KIND = { community: 'сообщество', chat: 'чат', channel: 'канал' };

const KEYS: unknown[][] = [['groups'], ['channels']];

export function GroupsPage() {
  const me = useMe();
  const can = (p: string) => me.data?.permissions.includes(p) ?? false;
  const { run, notice, setNotice } = useAction('', KEYS);
  const [connecting, setConnecting] = useState(false);
  const [tokenFor, setTokenFor] = useState<GroupRow | null>(null);
  const query = useQuery({
    queryKey: ['groups'],
    queryFn: () => api<GroupsData>('GET', '/api/groups'),
  });

  if (query.isPending) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (query.isError) return <Alert color="red">{query.error.message}</Alert>;

  const { groups, vkUploader } = query.data;
  const pending = groups.filter((g) => g.status === 'pending_confirmation');
  const listed = groups.filter((g) => g.status !== 'pending_confirmation');

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Group justify="space-between">
        <Stack gap={2}>
          <Title order={1} size="h2">
            Каналы
          </Title>
          <Text c="dimmed" size="sm">
            Куда можно отправлять посты и конкурсы.
          </Text>
        </Stack>
        {can('groups_manage') && (
          <Button size="md" onClick={() => setConnecting(true)}>
            + Подключить
          </Button>
        )}
      </Group>

      {notice && (
        <Alert color={notice.color} withCloseButton onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      {can('groups_pendingMax_review') && pending.map((g) => <PendingCard key={g.id} group={g} run={run} />)}

      <Card withBorder radius="lg" p={0}>
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Канал</Table.Th>
                <Table.Th>Сеть</Table.Th>
                <Table.Th>Теги</Table.Th>
                <Table.Th>Состояние</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {listed.map((g) => (
                <Table.Tr key={g.id}>
                  <Table.Td>
                    <Text fw={500}>{g.title}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {g.platform.toUpperCase()} · {KIND[g.kind]}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <TagsCell group={g} editable={can('groups_tags_edit') && g.status !== 'removed'} run={run} />
                  </Table.Td>
                  <Table.Td>
                    <Badge color={STATUS[g.status].color} variant="light">
                      {STATUS[g.status].label}
                    </Badge>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Group gap="xs" justify="flex-end" wrap="nowrap">
                      {g.platform === 'vk' && can('groups_tokens_manage') && g.status !== 'removed' && (
                        <Button size="xs" variant="light" onClick={() => setTokenFor(g)}>
                          {g.status === 'token_invalid' ? 'Обновить токен' : 'Сменить токен'}
                        </Button>
                      )}
                      {can('groups_manage') && g.status !== 'removed' && (
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          onClick={() =>
                            window.confirm(`Отключить «${g.title}»? Туда перестанут уходить посты.`) &&
                            void run(() => api('POST', `/api/groups/${g.id}/deactivate`), `«${g.title}» отключён`)
                          }
                        >
                          Отключить
                        </Button>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {listed.length === 0 && (
          <Text c="dimmed" ta="center" p="lg">
            Каналов пока нет.
          </Text>
        )}
      </Card>

      {vkUploader && <VkUploaderCard status={vkUploader} />}

      {connecting && <ConnectModal canVk={can('groups_tokens_manage') && vkUploader != null} onClose={() => setConnecting(false)} />}
      {tokenFor && <TokenModal group={tokenFor} onClose={() => setTokenFor(null)} />}
    </Stack>
  );
}

type Run = ReturnType<typeof useAction>['run'];

function PendingCard({ group, run }: { group: GroupRow; run: Run }) {
  const [tags, setTags] = useState<string[]>([]);
  return (
    <Alert color="yellow" title={`Бота добавили в «${group.title}». Подключить как ${KIND[group.kind]} для рассылок?`}>
      <Group align="flex-end" gap="sm">
        <TagsInput
          style={{ flex: '1 1 240px' }}
          label="Теги"
          placeholder="Например, магазины"
          value={tags}
          onChange={setTags}
        />
        <Button
          onClick={() =>
            void run(() => api('POST', `/api/groups/${group.id}/confirm`, { tags }), `«${group.title}» подключён`)
          }
        >
          Подтвердить
        </Button>
        <Button
          variant="default"
          onClick={() => void run(() => api('POST', `/api/groups/${group.id}/reject`), `«${group.title}» отклонён`)}
        >
          Отклонить
        </Button>
      </Group>
    </Alert>
  );
}

function TagsCell({ group, editable, run }: { group: GroupRow; editable: boolean; run: Run }) {
  const [editing, setEditing] = useState(false);
  const [tags, setTags] = useState(group.tags);
  if (!editing) {
    return (
      <Group gap={4}>
        {group.tags.length === 0 && <Text c="dimmed">—</Text>}
        {group.tags.map((t) => (
          <Badge key={t} variant="outline" color="gray">
            #{t}
          </Badge>
        ))}
        {editable && (
          <Anchor component="button" size="xs" onClick={() => setEditing(true)}>
            изменить
          </Anchor>
        )}
      </Group>
    );
  }
  return (
    <Group gap="xs" wrap="nowrap">
      <TagsInput
        aria-label={`Теги «${group.title}»`}
        value={tags}
        onChange={setTags}
        size="xs"
        style={{ minWidth: 180 }}
      />
      <Button
        size="xs"
        onClick={() =>
          void run(() => api('POST', `/api/groups/${group.id}/tags`, { tags }), 'Теги сохранены').then(
            (ok) => ok && setEditing(false),
          )
        }
      >
        OK
      </Button>
    </Group>
  );
}

function ConnectModal({ canVk, onClose }: { canVk: boolean; onClose: () => void }) {
  const { run, notice, pending } = useAction('', KEYS);
  const [token, setToken] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  return (
    <Modal opened onClose={onClose} title="Подключить канал" size="lg" centered>
      <Stack>
        <Title order={3} size="h5">
          MAX
        </Title>
        <Text size="sm">
          Добавьте бота в канал или чат администратором. Он сразу появится вверху этой страницы — останется подтвердить.
        </Text>
        {canVk && (
          <>
            <Title order={3} size="h5" mt="sm">
              VK
            </Title>
            <PasswordInput
              label="Токен сообщества"
              description="Управление сообществом → Работа с API → Ключи доступа. Права: управление, стена, фото."
              value={token}
              onChange={(e) => setToken(e.currentTarget.value)}
            />
            <TagsInput label="Теги" value={tags} onChange={setTags} />
            <ModalNotice notice={notice} />
            <Button
              style={{ alignSelf: 'flex-start' }}
              loading={pending}
              disabled={!token.trim()}
              onClick={() =>
                void run(
                  () =>
                    api('POST', '/api/groups/vk', {
                      token: token.trim(),
                      tags,
                    }),
                  'Сообщество подключено',
                ).then((ok) => ok && onClose())
              }
            >
              Подключить сообщество
            </Button>
          </>
        )}
      </Stack>
    </Modal>
  );
}

function TokenModal({ group, onClose }: { group: GroupRow; onClose: () => void }) {
  const { run, notice, pending } = useAction('', KEYS);
  const [token, setToken] = useState('');
  return (
    <Modal opened onClose={onClose} title={`Токен «${group.title}»`} centered>
      <Stack>
        {group.tokenMask && (
          <Text size="sm" c="dimmed">
            Сейчас: {group.tokenMask}
          </Text>
        )}
        <PasswordInput label="Новый токен сообщества" value={token} onChange={(e) => setToken(e.currentTarget.value)} />
        <ModalNotice notice={notice} />
        <Button
          loading={pending}
          disabled={!token.trim()}
          onClick={() =>
            void run(
              () =>
                api('POST', `/api/groups/${group.id}/token`, {
                  token: token.trim(),
                }),
              'Токен обновлён',
            ).then((ok) => ok && onClose())
          }
        >
          Сохранить
        </Button>
      </Stack>
    </Modal>
  );
}

function VkUploaderCard({ status }: { status: NonNullable<GroupsData['vkUploader']> }) {
  const { run, notice, pending } = useAction('', KEYS);
  const [pasted, setPasted] = useState('');
  const state =
    status.state === 'usable'
      ? `действует до ${formatDateTime(status.expiresAt!)}`
      : status.state === 'expired'
        ? `истёк ${formatDateTime(status.expiresAt!)}`
        : 'не подключён';

  return (
    <Card withBorder radius="lg" p="lg">
      <Stack gap="sm">
        <Title order={2} size="h4">
          Загрузка картинок в VK
        </Title>
        <Text size="sm" c="dimmed">
          Нужен личный токен, живёт 24 часа. Сейчас: {state}.
        </Text>
        {!status.appConfigured ? (
          <Alert color="orange">Не заданы VK_APP_ID и VK_APP_CLIENT_SECRET — авторизацию не начать.</Alert>
        ) : (
          <>
            <Button
              onClick={() => void openWithSession('/vk/oauth/authorize', true).catch(() => undefined)}
              variant="light"
              style={{ alignSelf: 'flex-start' }}
            >
              1. Открыть авторизацию VK
            </Button>
            <Textarea
              label="2. Вставьте адрес страницы, на которой оказались после разрешения доступа"
              autosize
              minRows={2}
              value={pasted}
              onChange={(e) => setPasted(e.currentTarget.value)}
            />
            <ModalNotice notice={notice} />
            <Button
              style={{ alignSelf: 'flex-start' }}
              loading={pending}
              disabled={!pasted.trim()}
              onClick={() =>
                void run(() => api('POST', '/api/groups/vk-uploader', { pasted }), 'Токен подключён').then(
                  (ok) => ok && setPasted(''),
                )
              }
            >
              Подключить
            </Button>
          </>
        )}
      </Stack>
    </Card>
  );
}

function ModalNotice({ notice }: { notice: Notice | null }) {
  return notice ? <Alert color={notice.color}>{notice.text}</Alert> : null;
}
