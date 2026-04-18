import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { TargetingSchema } from './targeting';

export interface WorkerCliArgs {
  jobId?: string;
  targeting: z.infer<typeof TargetingSchema>;
}

function parseTargetingValue(targetingValue: string): unknown {
  const rawValue = targetingValue.startsWith('@')
    ? readFileSync(targetingValue.slice(1), 'utf8')
    : targetingValue;

  try {
    return JSON.parse(rawValue);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON passed to --targeting: ${detail}`);
  }
}

export function parseWorkerCliArgs(args: string[]): WorkerCliArgs {
  let targetingValue: string | undefined;
  let jobId: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--targeting') {
      const nextValue = args[i + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        throw new Error('Missing value after --targeting. Pass a JSON object like {"titles":["engineer"]}.');
      }

      targetingValue = nextValue;
      i += 1;
      continue;
    }

    if (arg === '--targeting-file') {
      const nextValue = args[i + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        throw new Error('Missing value after --targeting-file. Pass a path to a JSON file.');
      }

      targetingValue = `@${nextValue}`;
      i += 1;
      continue;
    }

    if (arg === '--job-id') {
      const nextValue = args[i + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        throw new Error('Missing value after --job-id.');
      }

      jobId = nextValue;
      i += 1;
    }
  }

  if (!targetingValue) {
    throw new Error('Missing required --targeting or --targeting-file argument.');
  }

  const parsedJson = parseTargetingValue(targetingValue);

  const parsed = TargetingSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issues = parsed.error.errors
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid --targeting payload: ${issues}`);
  }

  return { jobId, targeting: parsed.data };
}
