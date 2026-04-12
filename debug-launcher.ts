/**
 * Debug launcher — simulates Bree's worker_threads setup
 * so we can run worker.ts standalone with real Playwright.
 *
 * Usage: npx tsx debug-launcher.ts
 */

import { Worker } from 'worker_threads';
import * as path from 'path';

const workerData = {
  jobId: 'debug-job-001',
  targeting: {
    titles: ['engineer'],
    locations: ['United States'],
  },
};

const workerPath = path.resolve(__dirname, 'dist/worker.js');

console.log('[DEBUG] Spawning worker with workerData:', JSON.stringify(workerData, null, 2));

const worker = new Worker(workerPath, { workerData });

worker.on('message', (msg: unknown) => {
  console.log('[WORKER message]:', JSON.stringify(msg, null, 2));
});

worker.on('error', (err: Error) => {
  console.error('[WORKER error]:', err.message, err.stack);
});

worker.on('exit', (code: number) => {
  console.log(`[WORKER exit] code=${code}`);
  process.exit(code);
});

console.log('[DEBUG] Worker thread launched, waiting for messages...');