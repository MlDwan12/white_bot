import { useState } from 'react';
import { Alert, Anchor, Button, Card, SimpleGrid, Stack, Title } from '@mantine/core';
import { RichText } from '../RichText';
import { Link } from 'react-router';
import { api, ApiError, type Media } from '../api';
import { DmTarget, dmTargetReady, type DmTargetValue } from '../DmTarget';
import { MediaPicker } from '../MediaPicker';

/** «Написать в личку»: сообщение создаётся и уходит одним действием, без поста в каналах. */
export function DirectMessagePage() {
  const [text, setText] = useState('');
  const [media, setMedia] = useState<Media[]>([]);
  const [target, setTarget] = useState<DmTargetValue>({
    mode: 'user',
    platformUserId: null,
  });
  const [notice, setNotice] = useState<{
    color: 'green' | 'red';
    text: string;
  } | null>(null);
  const [pending, setPending] = useState(false);

  const send = async () => {
    setPending(true);
    setNotice(null);
    try {
      const { queued } = await api<{ queued: number }>('POST', '/api/direct-messages', {
        text,
        attachmentIds: media.map((m) => m.id),
        ...target,
      });
      setNotice({ color: 'green', text: `Поставлено в очередь: ${queued}` });
      // Отправлено — форма чистая, иначе повторное нажатие разошлёт второй раз.
      setText('');
      setMedia([]);
    } catch (err) {
      setNotice({
        color: 'red',
        text: err instanceof ApiError ? err.message : 'Не удалось отправить',
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Stack gap="lg" maw={1040} mx="auto">
      <Stack gap={4}>
        <Anchor component={Link} to="/posts" size="sm">
          ← Посты
        </Anchor>
        <Title order={1} size="h2">
          Написать в личку
        </Title>
      </Stack>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Stack>
          <RichText label="Текст" minRows={6} value={text} onChange={setText} />
          <MediaPicker value={media} onChange={setMedia} />
        </Stack>
        <Card withBorder radius="lg" p="lg">
          <DmTarget value={target} onChange={setTarget} />
        </Card>
      </SimpleGrid>
      {notice && <Alert color={notice.color}>{notice.text}</Alert>}
      <Button
        style={{ alignSelf: 'flex-end' }}
        size="md"
        loading={pending}
        disabled={!dmTargetReady(target) || (!text.trim() && media.length === 0)}
        onClick={() => void send()}
      >
        Разослать
      </Button>
    </Stack>
  );
}
