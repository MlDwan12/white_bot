import { useQuery } from '@tanstack/react-query';
import { api, type ChannelOption, type Me } from './api';
import { setTimeZone } from './format';

/** Каналы, куда можно публиковать (у admin — без VK, отфильтровано сервером). */
export function useChannels() {
  return useQuery({ queryKey: ['channels'], queryFn: () => api<ChannelOption[]>('GET', '/api/groups/active') });
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api<Me>('GET', '/auth/me').then((me) => {
        setTimeZone(me.timeZone);
        return me;
      }),
  });
}
