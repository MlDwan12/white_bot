import { useState, type FormEvent } from 'react';
import { Alert, Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';

export function LoginPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api('POST', '/auth/login', {
        email: String(form.get('email') ?? '').trim(),
        password: String(form.get('password') ?? ''),
      });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Слишком много попыток. Подождите минуту.'
          : err instanceof ApiError
            ? err.message
            : 'Сервер недоступен',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Center mih="100vh" p="md" bg="gray.1">
      <Paper component="form" onSubmit={submit} withBorder radius="lg" p="xl" w="100%" maw={400}>
        <Stack gap="md">
          <div>
            <Title order={2} size="h3">
              White Bot
            </Title>
            <Text c="dimmed">Панель рассылок и конкурсов</Text>
          </div>
          {error && <Alert color="red">{error}</Alert>}
          <TextInput name="email" type="email" label="Email" autoComplete="username" required size="md" />
          <PasswordInput name="password" label="Пароль" autoComplete="current-password" required size="md" />
          <Button type="submit" size="md" loading={pending}>
            Войти
          </Button>
          <Text size="sm" c="dimmed">
            Нет доступа или забыли пароль — попросите администратора выдать новый.
          </Text>
        </Stack>
      </Paper>
    </Center>
  );
}
