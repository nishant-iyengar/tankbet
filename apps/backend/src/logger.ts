type LogContext = Record<string, unknown>;

function formatMessage(level: string, msgOrCtx: string | LogContext, msg?: string): string {
  const timestamp = new Date().toISOString();
  if (typeof msgOrCtx === 'string') {
    return JSON.stringify({ level, time: timestamp, name: 'tankbet', msg: msgOrCtx });
  }
  return JSON.stringify({ level, time: timestamp, name: 'tankbet', ...msgOrCtx, msg });
}

export const logger = {
  info(msgOrCtx: string | LogContext, msg?: string): void {
    console.log(formatMessage('INFO', msgOrCtx, msg));
  },
  warn(msgOrCtx: string | LogContext, msg?: string): void {
    console.warn(formatMessage('WARN', msgOrCtx, msg));
  },
  error(msgOrCtx: string | LogContext, msg?: string): void {
    console.error(formatMessage('ERROR', msgOrCtx, msg));
  },
};
