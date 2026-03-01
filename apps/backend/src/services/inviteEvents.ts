import type { ServerResponse } from 'node:http';

const subscribers = new Map<string, Set<ServerResponse>>();

export function subscribe(gameId: string, res: ServerResponse): void {
  let subs = subscribers.get(gameId);
  if (!subs) {
    subs = new Set();
    subscribers.set(gameId, subs);
  }
  subs.add(res);
}

export function unsubscribe(gameId: string, res: ServerResponse): void {
  const subs = subscribers.get(gameId);
  if (!subs) return;
  subs.delete(res);
  if (subs.size === 0) {
    subscribers.delete(gameId);
  }
}

export function notify(gameId: string, data: Record<string, unknown>): void {
  const subs = subscribers.get(gameId);
  if (!subs) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of subs) {
    res.write(payload);
  }
  // Clean up after notifying — the invite lifecycle is complete
  subscribers.delete(gameId);
}
