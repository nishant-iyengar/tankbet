import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin, HtmlTagDescriptor } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

const LOG_PATH = path.resolve(__dirname, '../../logs/browser.log');

const RELAY_SCRIPT = `
(function () {
  const ENDPOINT = '/__console';
  function send(level, args) {
    var msg;
    try {
      msg = args.map(function (a) {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') return JSON.stringify(a, null, 2);
        return String(a);
      }).join(' ');
    } catch (_) {
      msg = '[unserializable]';
    }
    var now = new Date().toISOString().replace('T', ' ').slice(0, 23);
    var line = '[' + now + '] [' + level + '] ' + msg;
    navigator.sendBeacon(ENDPOINT, line);
  }
  var _error = console.error.bind(console);
  var _warn  = console.warn.bind(console);
  var _log   = console.log.bind(console);
  console.error = function () { send('ERROR', Array.from(arguments)); _error.apply(console, arguments); };
  console.warn  = function () { send('WARN',  Array.from(arguments)); _warn.apply(console,  arguments); };
  console.log   = function () { send('LOG',   Array.from(arguments)); _log.apply(console,   arguments); };
  window.addEventListener('error', function (e) {
    send('UNCAUGHT', [e.error || e.message]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    send('UNHANDLED_REJECTION', [e.reason]);
  });
})();
`.trim();

function browserConsoleRelay(): Plugin {
  return {
    name: 'browser-console-relay',
    apply: 'serve',

    configureServer(server) {
      server.middlewares.use(
        '/__console',
        (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
          }
          let body = '';
          req.setEncoding('utf8');
          req.on('data', (chunk: string) => { body += chunk; });
          req.on('end', () => {
            try {
              fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
              fs.appendFileSync(LOG_PATH, body + '\n');
            } catch (_) { /* non-fatal */ }
            res.writeHead(204).end();
          });
        },
      );
    },

    transformIndexHtml() {
      const tag: HtmlTagDescriptor = {
        tag: 'script',
        attrs: {},
        children: RELAY_SCRIPT,
        injectTo: 'head-prepend',
      };
      return [tag];
    },
  };
}

export default defineConfig({
  plugins: [browserConsoleRelay(), react()],
  server: {
    port: 5173,
  },
});
