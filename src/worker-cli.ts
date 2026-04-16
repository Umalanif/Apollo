import { z } from 'zod';
import { createWorkerJobData, runWorkerJob } from './worker';
import { logger } from './logger';

const TargetingSchema = z.object({
  keywords: z.array(z.string()).optional(),
  titles: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional(),
  companies: z.array(z.string()).optional(),
});

function parseArgs(): { jobId?: string; targeting: z.infer<typeof TargetingSchema> } {
  const args = process.argv.slice(2);
  let targetingValue: string | undefined;
  let jobId: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--targeting') {
      targetingValue = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--job-id') {
      jobId = args[i + 1];
      i += 1;
    }
  }

  if (!targetingValue) {
    throw new Error('Missing required --targeting argument with JSON payload');
  }

  const parsed = TargetingSchema.parse(JSON.parse(targetingValue));
  return { jobId, targeting: parsed };
}

async function main(): Promise<void> {
  const { jobId, targeting } = parseArgs();
  await runWorkerJob(createWorkerJobData(targeting, jobId));
}

void main().catch((err: unknown) => {
  logger.error({ err }, 'Standalone worker failed');
  process.exit(1);
});
