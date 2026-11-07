import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { svc: 'ws' },
    redact: {
      paths: ['*.cookie', '*.headers.cookie', '*.password', '*.token'],
      censor: '[redacted]',
    },
  });
}
