import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { ActionIcon, Alert, Box, Group, Image, Loader, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { ApiError, previewUrl, uploadMedia, type Media } from './api';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm';

/**
 * Вложения публикации: перетащить, выбрать или вставить Ctrl+V. Файл
 * загружается сразу, а к посту привязывается, только когда форму сохранят.
 */
export function MediaPicker({ value, onChange }: { value: Media[]; onChange: (next: Media[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  // Загрузки идут параллельно: к концу одной список мог пополниться другой.
  const latest = useRef(value);
  latest.current = value;

  const add = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    setBusy((n) => n + files.length);
    const added: Media[] = [];
    for (const file of files) {
      try {
        added.push(await uploadMedia(file));
      } catch (err) {
        setError(`«${file.name}»: ${err instanceof ApiError ? err.message : 'не загрузился'}`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
    if (added.length > 0) onChange([...latest.current, ...added]);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    void add([...event.dataTransfer.files]);
  };

  const onPaste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
      event.preventDefault();
      void add(files);
    }
  };

  return (
    <Stack gap="xs" onPaste={onPaste}>
      {value.length > 0 && (
        <Group gap="xs">
          {value.map((media) => (
            <Paper key={media.id} withBorder radius="md" p={4} pos="relative">
              {media.kind === 'image' ? (
                <Image src={previewUrl(media.id)} alt={media.filename} w={88} h={88} radius="sm" fit="cover" />
              ) : (
                <Box w={88} h={88} p={6} bg="gray.1" style={{ borderRadius: 4, overflow: 'hidden' }}>
                  <Text size="xs" lineClamp={4}>
                    {media.kind === 'video' ? 'Видео' : 'Файл'}: {media.filename}
                  </Text>
                </Box>
              )}
              <ActionIcon
                aria-label={`Убрать ${media.filename}`}
                size="sm"
                radius="xl"
                color="dark"
                pos="absolute"
                top={-6}
                right={-6}
                onClick={() => onChange(value.filter((m) => m.id !== media.id))}
              >
                ×
              </ActionIcon>
            </Paper>
          ))}
        </Group>
      )}
      <UnstyledButton
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        p="md"
        style={{
          border: `2px dashed var(--mantine-color-${over ? 'blue-5' : 'gray-4'})`,
          borderRadius: 'var(--mantine-radius-md)',
          textAlign: 'center',
        }}
      >
        {busy > 0 ? (
          <Loader size="sm" />
        ) : (
          <>
            <Text size="sm">Перетащите, выберите файл или вставьте Ctrl+V</Text>
            <Text size="xs" c="dimmed">
              JPG, PNG, MP4 — до 50 МБ
            </Text>
          </>
        )}
      </UnstyledButton>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void add([...(e.currentTarget.files ?? [])]);
          e.currentTarget.value = '';
        }}
      />
      {error && (
        <Alert color="red" p="xs">
          {error}
        </Alert>
      )}
    </Stack>
  );
}
