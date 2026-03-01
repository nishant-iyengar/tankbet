const API_URL: string = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001';

interface FetchOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
}

export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' })) as { error: string };
    throw new Error(error.error ?? `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}
