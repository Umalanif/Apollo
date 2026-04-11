/**
 * Structured JSON logger — Pino
 *
 * All log output is JSON (machine-parseable).
 * In worker_threads context, stdout/stderr are piped to parent process.
 */

import pino from 'pino';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// Ensure logs directory exists synchronously at startup
const logsDir = join(process.cwd(), 'logs');
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: label => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    target: 'pino/file',
    options: {
      destination: join(process.cwd(), 'logs', 'combined.log'),
      mkdir: true,
    },
  },
});

export default logger;
