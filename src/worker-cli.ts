import { createWorkerJobData, runWorkerJob } from './worker';
import { logger } from './logger';
import { parseWorkerCliArgs } from './worker-cli-args';

async function main(): Promise<void> {
  const { jobId, targeting, maxLeads } = parseWorkerCliArgs(process.argv.slice(2));
  await runWorkerJob(createWorkerJobData(targeting, jobId, maxLeads));
}

void main().catch((err: unknown) => {
  logger.error({ err }, 'Standalone worker failed');
  process.exit(1);
});
