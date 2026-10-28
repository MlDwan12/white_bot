import { useState } from 'react';
import { Alert, Anchor, Button, Group, Stack, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api';
import { useChannels } from '../hooks';
import { plural } from '../format';
import { draftPayload, EMPTY_POST, PostFields, type PostDraft } from '../PostFields';

export function NewPostPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const channels = useChannels();
  const [draft, setDraft] = useState<PostDraft>(EMPTY_POST);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (send: boolean) => {
    setPending(true);
    setError(null);
    try {
      const result = await api<{
        id: string;
        sendError: { message: string } | null;
      }>('POST', '/api/posts', {
        ...draftPayload(draft),
        send,
      });
      await queryClient.invalidateQueries({ queryKey: ['posts'] });
      // Пост сохранён, даже если отправка отказала: на его карточке видна
      // причина, а повторное «Отправить» здесь создало бы второй такой же.
      navigate(`/posts/${result.id}`, {
        state: { sendError: result.sendError?.message ?? null },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать пост');
    } finally {
      setPending(false);
    }
  };

  const count = draft.groupIds.length;
  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Stack gap={4}>
        <Anchor component={Link} to="/posts" size="sm">
          ← Посты
        </Anchor>
        <Title order={1} size="h2">
          Новый пост
        </Title>
      </Stack>
      <PostFields value={draft} onChange={setDraft} channels={channels.data ?? []} />
      {error && <Alert color="red">{error}</Alert>}
      <Group justify="flex-end">
        <Button variant="default" loading={pending} onClick={() => void submit(false)}>
          Сохранить черновик
        </Button>
        <Button loading={pending} disabled={count === 0} onClick={() => void submit(true)}>
          {draft.scheduledAt
            ? 'Запланировать'
            : `Отправить в ${count} ${plural(count, ['канал', 'канала', 'каналов'])}`}
        </Button>
      </Group>
    </Stack>
  );
}
