/**
 * Bottleneck rate limiter — 3-15s random delay per task
 *
 * Anti-detection: random jitter prevents request cadence fingerprinting.
 * Sticky session affinity: caller increments port on failure to get new exit IP.
 *
 * Implementation: minTime=3000 (hard floor) + random extra inside each scheduled task.
 * Bottleneck.schedule() waits minTime before launching the next job, so the
 * actual inter-request gap is 3000 + random(0-12000) = 3-15s.
 */

import Bottleneck from 'bottleneck';
import { logger } from './logger';

// ── Random extra delay in ms (0-12s on top of the 3s floor) ───────────────────

function randomExtraDelay(): number {
  // 0 to 12000 ms extra — combined with 3000ms floor = 3-15s total
  return Math.floor(Math.random() * 12_000);
}

// ── Bottleneck instance ────────────────────────────────────────────────────────

export const limiter = new Bottleneck({
  // One request at a time — maximum discipline
  maxConcurrent: 1,

  // Hard floor: 3 seconds between task starts
  minTime: 3_000,
});

// Log key lifecycle events (debug level)
limiter.on('scheduled', () => {
  logger.debug('Bottleneck: task scheduled');
});

limiter.on('done', () => {
  logger.debug('Bottleneck: task done');
});

/**
 * Wrap any async task with the bottleneck limiter.
 * Adds a random 0-12s extra delay on top of the 3s floor (total: 3-15s).
 *
 * @example
 *   const result = await wrap(async () => {
 *     await new Promise(r => setTimeout(r, randomExtraDelay()));
 *     return got.post(url, { json: body });
 *   });
 */
export function wrap<T>(task: () => Promise<T>): Promise<T> {
  return limiter.schedule(async () => {
    // Random extra jitter: 0-12 seconds
    const extra = randomExtraDelay();
    if (extra > 0) {
      await new Promise(resolve => setTimeout(resolve, extra));
    }
    return task();
  });
}
