import { useState } from 'react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Center,
  Code,
  CopyButton,
  Group,
  Loader,
  Menu,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { formatDate, formatDateTime } from '../format';
import { useMe } from '../hooks';
import type { AdminRow, IssuedAdmin } from '@white-bot/shared';

const ROLE = {
  developer: 'Разработчик',
  admin: 'Админ (посты, конкурсы, каналы MAX)',
};

export function AdminsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['admins'],
    queryFn: () => api<AdminRow[]>('GET', '/api/admins'),
  });
  const [editing, setEditing] = useState<AdminRow | 'new' | null>(null);
  const [issued, setIssued] = useState<{
    email: string;
    password: string;
    reason: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (path: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setError(null);
    try {
      return await api<unknown>('POST', path);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['admins'] });
    }
  };

  const reset = async (a: AdminRow) => {
    const result = (await act(
      `/api/admins/${a.id}/reset-password`,
      `Сбросить пароль ${a.email}? Его текущие входы закончатся.`,
    )) as IssuedAdmin | undefined;
    if (result)
      setIssued({
        email: result.admin.email,
        password: result.password,
        reason: 'Новый пароль',
      });
  };

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Group justify="space-between">
        <Title order={1} size="h2">
          Админы
        </Title>
        <Button size="md" onClick={() => setEditing('new')}>
          + Добавить админа
        </Button>
      </Group>
      {error && (
        <Alert color="red" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {query.isPending && (
        <Center py="xl">
          <Loader />
        </Center>
      )}
      {query.isError && <Alert color="red">{query.error.message}</Alert>}
      <Stack gap="sm">
        {query.data?.map((a) => {
          const self = a.id === me.data?.id;
          return (
            <Card key={a.id} withBorder radius="lg" p="md" opacity={a.disabledAt ? 0.7 : 1}>
              <Group justify="space-between" wrap="wrap">
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  <Avatar radius="xl" color={a.disabledAt ? 'gray' : 'blue'}>
                    {a.email[0]?.toUpperCase()}
                  </Avatar>
                  <Stack gap={2} style={{ minWidth: 0 }}>
                    <Group gap="xs">
                      <Text fw={600} truncate>
                        {a.email}
                      </Text>
                      {self && <Badge variant="light">это вы</Badge>}
                    </Group>
                    <Text size="sm" c="dimmed">
                      {a.disabledAt
                        ? `Отключён ${formatDate(a.disabledAt)} · войти не может`
                        : `${ROLE[a.role]} · ${a.maxUserId ? 'уведомления в MAX включены' : 'MAX не привязан'}${
                            a.lastSeenAt ? ` · был ${formatDateTime(a.lastSeenAt)}` : ''
                          }`}
                    </Text>
                  </Stack>
                </Group>
                {a.disabledAt ? (
                  <Button variant="default" size="xs" onClick={() => void act(`/api/admins/${a.id}/enable`)}>
                    Включить
                  </Button>
                ) : (
                  <Group gap="xs">
                    <Button variant="default" size="xs" onClick={() => setEditing(a)}>
                      Изменить
                    </Button>
                    {!self && (
                      <Menu position="bottom-end">
                        <Menu.Target>
                          <Button variant="default" size="xs" aria-label={`Ещё для ${a.email}`}>
                            ⋯
                          </Button>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item onClick={() => void reset(a)}>Сбросить пароль</Menu.Item>
                          <Menu.Item
                            color="red"
                            onClick={() =>
                              void act(
                                `/api/admins/${a.id}/disable`,
                                `Отключить ${a.email}? Войти он больше не сможет, его действия останутся в журналах.`,
                              )
                            }
                          >
                            Отключить
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    )}
                  </Group>
                )}
              </Group>
            </Card>
          );
        })}
      </Stack>
      <Text size="sm" c="dimmed">
        Админ ведёт посты, конкурсы и каналы MAX. Разработчик может всё, включая VK и эту страницу. Удалить админа
        нельзя, только отключить — его действия остаются в журналах. Пароль генерируется и показывается один раз.
      </Text>

      {editing && (
        <EditModal
          admin={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onIssued={(i) =>
            setIssued({
              email: i.admin.email,
              password: i.password,
              reason: 'Админ добавлен',
            })
          }
        />
      )}
      {issued && (
        <Modal opened onClose={() => setIssued(null)} title={issued.reason} centered>
          <Stack>
            <Text>
              Пароль для <b>{issued.email}</b>. Он показывается один раз — передайте его сейчас.
            </Text>
            <Group>
              <Code fz="lg">{issued.password}</Code>
              <CopyButton value={issued.password}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="light" onClick={copy}>
                    {copied ? 'Скопировано' : 'Копировать'}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <Button onClick={() => setIssued(null)}>Готово</Button>
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}

function EditModal({
  admin,
  onClose,
  onIssued,
}: {
  admin: AdminRow | null;
  onClose: () => void;
  onIssued: (i: IssuedAdmin) => void;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'developer'>(admin?.role ?? 'admin');
  const [maxUserId, setMaxUserId] = useState(admin?.maxUserId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      if (admin) {
        await api('POST', `/api/admins/${admin.id}`, { role, maxUserId });
      } else {
        onIssued(await api<IssuedAdmin>('POST', '/api/admins', { email, role, maxUserId }));
      }
      await queryClient.invalidateQueries({ queryKey: ['admins'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title={admin ? admin.email : 'Новый админ'} centered>
      <Stack>
        {!admin && (
          <TextInput label="Email" type="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
        )}
        <SegmentedControl
          value={role}
          onChange={(v) => setRole(v as 'admin' | 'developer')}
          data={[
            { value: 'admin', label: 'Админ' },
            { value: 'developer', label: 'Разработчик' },
          ]}
        />
        <TextInput
          label="Id в MAX"
          description="Для уведомлений и команд боту из чата. Пусто — не привязан."
          value={maxUserId}
          onChange={(e) => setMaxUserId(e.currentTarget.value)}
        />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Отмена
          </Button>
          <Button loading={pending} onClick={() => void save()}>
            {admin ? 'Сохранить' : 'Добавить'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
