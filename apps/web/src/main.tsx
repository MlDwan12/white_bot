import '@mantine/core/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { ApiError } from './api';
import { Layout } from './Layout';
import { ContestsPage } from './pages/ContestsPage';
import { ContestPage } from './pages/contest/ContestPage';
import { NewContestPage } from './pages/NewContestPage';
import { PostsPage } from './pages/PostsPage';
import { NewPostPage } from './pages/NewPostPage';
import { PostPage } from './pages/PostPage';
import { DirectMessagePage } from './pages/DirectMessagePage';
import { GroupsPage } from './pages/GroupsPage';
import { TemplatePage, TemplatesPage } from './pages/TemplatesPage';
import { AdminsPage } from './pages/AdminsPage';
import { AuditPage } from './pages/AuditPage';
import { StatsPage } from './pages/StatsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 401/403/404 повтором не лечатся, а вход показывается сразу.
      retry: (count, err) =>
        !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      children: [
        { index: true, element: <Navigate to="/contests" replace /> },
        { path: 'contests', element: <ContestsPage /> },
        { path: 'contests/new', element: <NewContestPage /> },
        { path: 'contests/:id', element: <ContestPage /> },
        { path: 'posts', element: <PostsPage /> },
        { path: 'posts/new', element: <NewPostPage /> },
        { path: 'posts/:id', element: <PostPage /> },
        { path: 'direct-messages/new', element: <DirectMessagePage /> },
        { path: 'groups', element: <GroupsPage /> },
        { path: 'templates', element: <TemplatesPage /> },
        { path: 'templates/new', element: <TemplatePage /> },
        { path: 'templates/:id', element: <TemplatePage /> },
        { path: 'admins', element: <AdminsPage /> },
        { path: 'audit', element: <AuditPage /> },
        { path: 'stats', element: <StatsPage /> },
      ],
    },
  ],
  { basename: '/app' },
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
