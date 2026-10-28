import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В разработке API — Nest на :3000; прокси держит всё на одном источнике,
// как в проде, иначе куки входа `SameSite=strict` до API не доедут.
const api = 'http://localhost:3000';

export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    proxy: {
      '/auth': api,
      '/api': api,
      '/vk': api,
      '/audit': api,
    },
  },
});
