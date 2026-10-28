import { useState } from 'react';
import { Alert, Badge, Button, Card, Center, Group, Loader, Stack, Tabs, Text, Title } from '@mantine/core';
import { postFirstLine } from '../RichText';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, ApiError, type PostSummary } from '../api';
import { formatDateTime, plural } from '../format';
import { POST_STATUS } from '../PostFields';

const FILTERS = [
  { value: 'all', label: 'Все', match: () => true },
  {
    value: 'scheduled',
    label: 'Запланированы',
    match: (p: PostSummary) => p.status === 'scheduled',
  },
  {
    value: 'failed',
    label: 'С ошибками',
    match: (p: PostSummary) => p.failed > 0 || p.unknown > 0,
  },
  {
    value: 'draft',
    label: 'Черновики',
    match: (p: PostSummary) => p.status === 'draft',
  },
];

export function PostsPage() {
  const [filter, setFilter] = useState('all');
  const posts = useQuery({
    queryKey: ['posts'],
    queryFn: () => api<PostSummary[]>('GET', '/api/posts'),
  });
  const list = posts.data ?? [];
  const shown = list.filter(FILTERS.find((f) => f.value === filter)!.match);

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Group justify="space-between">
        <Title order={1} size="h2">
          Посты
        </Title>
        <Group gap="xs">
          <Button variant="default" size="md" component={Link} to="/direct-messages/new">
            Написать в личку
          </Button>
          <Button size="md" component={Link} to="/posts/new">
            + Новый пост
          </Button>
        </Group>
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

      {posts.isPending && (
        <Center py="xl">
          <Loader />
        </Center>
      )}
      {posts.isError && <Alert color="red">Не удалось загрузить посты: {posts.error.message}</Alert>}
      {posts.isSuccess && shown.length === 0 && (
        <Text c="dimmed" ta="center" py="xl">
          {list.length === 0 ? 'Постов пока нет.' : 'В этом разделе пусто.'}
        </Text>
      )}
      <Stack gap="sm">
        {shown.map((post) => (
          <PostRow key={post.id} post={post} />
        ))}
      </Stack>
    </Stack>
  );
}

function PostRow({ post }: { post: PostSummary }) {
  const queryClient = useQueryClient();
  const [resumeError, setResumeError] = useState<string | null>(null);
  const status = POST_STATUS[post.status];
  const firstLine = postFirstLine(post.text);
  const when =
    post.status === 'scheduled' && post.scheduledAt
      ? `Уйдёт ${formatDateTime(post.scheduledAt)}`
      : formatDateTime(post.scheduledAt ?? post.createdAt);
  const progress = post.status === 'draft' || post.status === 'scheduled' ? '' : ` · ${post.sent} из ${post.total}`;

  const resume = async () => {
    setResumeError(null);
    try {
      await api('POST', `/api/posts/${post.id}/resume`);
    } catch (err) {
      setResumeError(err instanceof ApiError ? err.message : 'Не удалось отправить');
    }
    await queryClient.invalidateQueries({ queryKey: ['posts'] });
  };

  return (
    <Card withBorder radius="lg" p="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Stack gap={4} style={{ flex: '1 1 300px', minWidth: 0 }}>
          <Text fw={600} truncate component={Link} to={`/posts/${post.id}`} c="inherit">
            {firstLine}
          </Text>
          <Text size="sm" c="dimmed">
            {when} · {post.total} {plural(post.total, ['канал', 'канала', 'каналов'])}
            {post.firstError &&
              ` · ${post.firstError.platform.toUpperCase()} «${post.firstError.groupTitle}»: ${post.firstError.error}`}
          </Text>
          {resumeError && (
            <Text size="sm" c="red">
              {resumeError}
            </Text>
          )}
        </Stack>
        <Group gap="xs">
          <Badge color={status.color} variant="light" radius="xl">
            {status.label}
            {progress}
          </Badge>
          {post.failed > 0 && (
            <Button size="xs" variant="light" onClick={() => void resume()}>
              Отправить оставшимся
            </Button>
          )}
        </Group>
      </Group>
    </Card>
  );
}
