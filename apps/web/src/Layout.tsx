import type { ReactNode } from 'react';
import {
  AppShell,
  Center,
  Group,
  Loader,
  Menu,
  NavLink as MantineNavLink,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router';
import { api, ApiError, type Me } from './api';
import { LoginPage } from './pages/LoginPage';

function Icon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

interface Section {
  label: string;
  icon: ReactNode;
  permission: string;
  to: string;
}

const SECTIONS: Section[] = [
  {
    label: 'Посты',
    icon: <Icon d="M4 4h16v16H4zM8 9h8M8 13h8M8 17h5" />,
    permission: 'posts_manage',
    to: '/posts',
  },
  {
    label: 'Конкурсы',
    icon: <Icon d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />,
    permission: 'contests_manage',
    to: '/contests',
  },
  {
    label: 'Каналы',
    icon: <Icon d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16M5 19h.01" />,
    permission: 'groups_view',
    to: '/groups',
  },
  {
    label: 'Повторяющиеся',
    icon: <Icon d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />,
    permission: 'posts_manage',
    to: '/templates',
  },
  {
    label: 'Админы',
    icon: <Icon d="M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a5 5 0 0 0-4-5" />,
    permission: 'admins_manage',
    to: '/admins',
  },
  {
    label: 'Статистика',
    icon: <Icon d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
    permission: 'audit_viewAll',
    to: '/stats',
  },
  {
    label: 'Журнал действий',
    icon: <Icon d="M12 8v4l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" />,
    permission: 'audit_viewAll',
    to: '/audit',
  },
];

/** На телефоне внизу помещаются три раздела, остальное — в «Ещё». */
const PHONE_TABS = 3;


export function Layout() {
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('GET', '/auth/me'),
  });

  if (me.isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <LoginPage />;
  }
  if (me.isError) {
    return (
      <Center h="100vh" p="md">
        <Text>Не удалось загрузить панель: {me.error.message}</Text>
      </Center>
    );
  }

  const sections = SECTIONS.filter((s) => me.data.permissions.includes(s.permission));
  const phoneTabs = sections.slice(0, PHONE_TABS);
  const phoneMore = sections.slice(PHONE_TABS);

  const logout = async () => {
    await api('POST', '/auth/logout').catch(() => undefined);
    queryClient.clear();
    await me.refetch();
  };

  return (
    <AppShell
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: true } }}
      footer={{ height: 64 }}
      padding={{ base: 'md', sm: 'xl' }}
      bg="gray.0"
    >
      <AppShell.Navbar p="sm">
        <Text fw={700} size="lg" px="sm" pt={4} pb="lg">
          White Bot
        </Text>
        <Stack gap={4} style={{ flex: 1 }}>
          {sections.map((section) => (
            <MantineNavLink
              key={section.label}
              component={NavLink}
              to={section.to}
              label={section.label}
              leftSection={section.icon}
              style={{ borderRadius: 8 }}
            />
          ))}
        </Stack>
        <Text size="sm" c="dimmed" px="sm" truncate>
          {me.data.email}
        </Text>
        <MantineNavLink component="button" label="Выйти" onClick={logout} style={{ borderRadius: 8 }} />
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>

      <AppShell.Footer hiddenFrom="sm">
        <Group grow gap={0} h="100%" component="nav" aria-label="Разделы">
          {phoneTabs.map((section) => (
            <PhoneTab key={section.label} section={section} />
          ))}
          <Menu position="top-end">
            <Menu.Target>
              <UnstyledButton c="gray.7" style={tabStyle}>
                <Icon d="M5 12h.01M12 12h.01M19 12h.01" />
                <Text size="xs">Ещё</Text>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              {phoneMore.map((section) => (
                <Menu.Item key={section.label} leftSection={section.icon} component={NavLink} to={section.to}>
                  {section.label}
                </Menu.Item>
              ))}
              <Menu.Divider />
              <Menu.Label>{me.data.email}</Menu.Label>
              <Menu.Item onClick={logout}>Выйти</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Footer>
    </AppShell>
  );
}

const tabStyle = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 2,
  height: '100%',
  textDecoration: 'none',
} as const;

function PhoneTab({ section }: { section: Section }) {
  const content = (
    <>
      {section.icon}
      <Text size="xs" inherit>
        {section.label}
      </Text>
    </>
  );
  return (
    <UnstyledButton
      component={NavLink}
      to={section.to}
      style={({ isActive }: { isActive: boolean }) => ({
        ...tabStyle,
        color: isActive ? 'var(--mantine-color-blue-7)' : 'var(--mantine-color-gray-7)',
        fontWeight: isActive ? 600 : 400,
      })}
    >
      {content}
    </UnstyledButton>
  );
}
