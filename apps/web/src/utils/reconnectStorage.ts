import { GRACE_PERIOD_SECONDS } from '@tankbet/game-engine/constants';

const RECONNECT_KEY_PREFIX = 'tankbet:reconnect:';
const RECONNECT_TIMESTAMP_PREFIX = 'tankbet:reconnect-ts:';

export function reconnectStorageKey(gameId: string): string {
  return `${RECONNECT_KEY_PREFIX}${gameId}`;
}

export function reconnectTimestampKey(gameId: string): string {
  return `${RECONNECT_TIMESTAMP_PREFIX}${gameId}`;
}

export function storeReconnectToken(gameId: string, token: string): void {
  localStorage.setItem(reconnectStorageKey(gameId), token);
  localStorage.setItem(reconnectTimestampKey(gameId), String(Date.now()));
}

export function clearReconnectToken(gameId: string): void {
  localStorage.removeItem(reconnectStorageKey(gameId));
  localStorage.removeItem(reconnectTimestampKey(gameId));
}

/** Remove stale reconnection tokens from localStorage on app startup. */
export function sweepStaleReconnectTokens(): void {
  const maxAge = GRACE_PERIOD_SECONDS * 1000;
  const now = Date.now();
  const keysToRemove: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(RECONNECT_TIMESTAMP_PREFIX)) continue;

    const ts = Number(localStorage.getItem(key));
    if (Number.isNaN(ts) || now - ts > maxAge) {
      const gameId = key.slice(RECONNECT_TIMESTAMP_PREFIX.length);
      keysToRemove.push(key);
      keysToRemove.push(RECONNECT_KEY_PREFIX + gameId);
    }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}
