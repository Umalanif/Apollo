import { createApp } from './server';
import { logger } from './logger';

const app = createApp();

async function bootstrap(): Promise<void> {
  await app.start(3000);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal');

  try {
    await app.stop();
    process.exit(0);
  } catch (err) {
    logger.error({ err, signal }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

void bootstrap().catch((err: unknown) => {
  logger.error({ err }, 'Failed to start Apollo application');
  process.exit(1);
});
