/**
 * Safari WebSocket compatibility patch for Colyseus SDK.
 *
 * The Colyseus SDK (v0.17) passes an options bag `{ headers, protocols }` as
 * the second argument to the WebSocket constructor.  Safari doesn't support the
 * options-bag format and stringifies the object to "[object Object]", which
 * fails protocol validation.  The SDK's try/catch fallback doesn't fire because
 * Safari doesn't throw synchronously in this case.
 *
 * This patch intercepts the WebSocket constructor and extracts `protocols` from
 * the options bag before forwarding to the native implementation.
 *
 * Import this file before any Colyseus code runs (e.g. at the top of main.tsx).
 */

function isOptionsBag(value: unknown): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

const NativeWebSocket = globalThis.WebSocket;

globalThis.WebSocket = new Proxy(NativeWebSocket, {
  construct(target, argsList: unknown[]) {
    const url = argsList[0];
    const protocols = argsList[1];

    if (isOptionsBag(protocols)) {
      const extracted = protocols['protocols'];
      if (extracted !== undefined && extracted !== null) {
        return Reflect.construct(target, [url, extracted]);
      }
      return Reflect.construct(target, [url]);
    }

    return Reflect.construct(target, argsList);
  },
});
