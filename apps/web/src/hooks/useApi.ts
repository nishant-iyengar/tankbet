import { useAppAuth } from '../auth/useAppAuth';
import { useCallback } from 'react';
import { apiFetch } from '../api/client';

export function useApi(): {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: unknown) => Promise<T>;
} {
  const { getToken } = useAppAuth();

  const get = useCallback(
    async <T>(path: string): Promise<T> => {
      const token = await getToken();
      return apiFetch<T>(path, { token });
    },
    [getToken],
  );

  const post = useCallback(
    async <T>(path: string, body?: unknown): Promise<T> => {
      const token = await getToken();
      return apiFetch<T>(path, { method: 'POST', body, token });
    },
    [getToken],
  );

  return { get, post };
}
