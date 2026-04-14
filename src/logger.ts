/**
 * Pino logger with pretty console output and file logging.
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
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        level: process.env.LOG_LEVEL ?? 'info',
        options: {
          colorize: false,
          ignore: 'pid,hostname',
          translateTime: 'SYS:standard',
        },
      },
      {
        target: 'pino/file',
        level: process.env.LOG_LEVEL ?? 'info',
        options: {
          destination: join(process.cwd(), 'logs', 'combined.log'),
          mkdir: true,
        },
      },
    ],
  },
});

export default logger;
