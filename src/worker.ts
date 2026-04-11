/**
 * Apollo Worker — Bree worker_threads context
 *
 * Receives job payload via parentPort (Bree workerData).
 * Runs extraction loop, persists leads via db.service,
 * then exports results to timestamped .csv/.xlsx.
 *
 * Phase 7.4: onChallengeDetected → reCAPTCHA sitekey → 2captcha-ts → token → inject
 * Phase 7.5/7.6: Cloudflare/DataDome → ChallengeBypassSignal → rotate proxy + re-hydrate
 *
 * Usage (Bree config):
 *   new Worker('./dist/worker.js', { workerData: { jobId, targeting } })
 *
 * Communication back to parent:
 *   parentPort.postMessage({ type: 'progress', payload: { collected, saved } })
 *   parentPort.postMessage({ type: 'done', payload: { exportedAt, filePaths } })
 *   parentPort.postMessage({ type: 'error', payload: { message, stack } })
 */

import { parentPort, workerData } from 'worker_threads';
import type { Page } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { saveLead } from './db/db.service';
import { exportLeads } from './export';
import { logger } from './logger';
import { createCrawler } from './crawler';
import { ChallengeDetection } from './challenge-detector';
import { solveRecaptcha } from './captcha-solver';
import { ChallengeBypassSignal } from './errors';
import { scrapeLeadsFromPage } from './leads-scraper';

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkerData {
  jobId: string;
  targeting: {
    keywords?: string[];
    titles?: string[];
    locations?: string[];
    companies?: string[];
  };
}

interface ProgressMessage {
  type: 'progress';
  payload: { collected: number; saved: number };
}

interface DoneMessage {
  type: 'done';
  payload: { exportedAt: string; filePaths: string[] };
}

interface ErrorMessage {
  type: 'error';
  payload: { message: string; stack?: string };
}

type OutgoingMessage = ProgressMessage | DoneMessage | ErrorMessage;

// ── Prisma ───────────────────────────────────────────────────────────────────

const prisma = new PrismaClient();

// ── Message helper ────────────────────────────────────────────────────────────

function post(msg: OutgoingMessage): void {
  parentPort?.postMessage(msg);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const data = workerData as WorkerData;

  logger.info({ jobId: data?.jobId, targeting: data?.targeting }, 'Worker started');

  if (!data?.jobId) {
    logger.error({ err: 'workerData.jobId is required' }, 'Invalid worker data');
    post({ type: 'error', payload: { message: 'workerData.jobId is required' } });
    return;
  }

  post({ type: 'progress', payload: { collected: 0, saved: 0 } });

  try {
    // ── Phase 7.4-7.6: Extraction loop with CAPTCHA + proxy rotation ────────
    // Retry loop:
    //   - reCAPTCHA  → solve via 2captcha, inject token, reset fail counter
    //   - Cloudflare / DataDome / generic_block → throw ChallengeBypassSignal → rotate port
    //   - 401/403 / network error → increment fail counter, rotate after x3

    const MAX_RETRIES = 3; // Phase 7.5: rotate proxy after 3 failures
    let proxyPort = 10_000;
    let failCount = 0;
    let saved = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let crawler: Awaited<ReturnType<typeof createCrawler>> | null = null;

      try {
        logger.info({ jobId: data.jobId, proxyPort }, 'Creating PlaywrightCrawler');

        // ── Build onChallengeDetected callback ─────────────────────────────────
        // This runs INSIDE the crawler's requestHandler, after detectChallenge(page).
        // `page` is available here for token injection.
        const onChallengeDetected = async (
          detection: ChallengeDetection,
          url: string,
          page: Page,
        ): Promise<void> => {
          logger.warn(
            { jobId: data.jobId, challengeType: detection.type, url },
            `Challenge detected: ${detection.message}`,
          );

          if (detection.type === 'recaptcha') {
            const sitekey = detection.sitekey;
            if (!sitekey) {
              // No sitekey → can't solve → signal proxy rotation
              throw new ChallengeBypassSignal('recaptcha', url);
            }

            logger.info(
              { jobId: data.jobId, sitekey: sitekey.slice(0, 10) + '…' },
              'Solving reCAPTCHA via 2captcha',
            );

            // solveRecaptcha already has internal retry logic (x3)
            const token = await solveRecaptcha(sitekey, url);

            // Inject token into browser context
            await page.evaluate((t: string) => {
              const win = window as unknown as Record<string, unknown>;

              // 1. Standard global callback if the page uses one
              if (typeof win.__recaptchaCallback === 'function') {
                (win.__recaptchaCallback as (token: string) => void)(t);
              }

              // 2. Invisible reCAPTCHA textarea (v2 checkbox / enterprise)
              const ta1 = document.querySelector<HTMLTextAreaElement>('#g-recaptcha-response');
              if (ta1) ta1.value = t;

              // 3. Data-sitekey attribute form field
              const ta2 = document.querySelector<HTMLTextAreaElement>('[name="g-recaptcha-response-data"]');
              if (ta2) ta2.value = t;

              // 4. Dispatch event for page's own listeners
              document.dispatchEvent(new CustomEvent('recaptcha-token-ready', { detail: { token: t } }));
            }, token);

            logger.info({ jobId: data.jobId }, 'reCAPTCHA token injected — page should auto-submit');
            failCount = 0; // successful solve resets counter
          } else {
            // Cloudflare, DataDome, generic_block → signal proxy rotation
            throw new ChallengeBypassSignal(detection.type ?? 'unknown', url);
          }
        };

        // ── onPageReady: extract leads from the live page before crawler teardown
        const onPageReady = async (page: Page, url: string): Promise<void> => {
          logger.debug({ jobId: data.jobId, url }, 'Running onPageReady extraction');

          const rawLeads = await scrapeLeadsFromPage(page, data.jobId);

          for (const raw of rawLeads) {
            try {
              await saveLead(data.jobId, raw);
              saved++;
              logger.debug({ jobId: data.jobId, linkedInUrl: raw.linkedInUrl }, 'Lead saved');
            } catch (err) {
              // saveLead already logs invalid parse as warn; other errors: log and continue
              if (err instanceof Error && !err.message.includes('Invalid lead data')) {
                logger.warn(
                  { jobId: data.jobId, err: err.message, linkedInUrl: raw.linkedInUrl },
                  'saveLead error — continuing',
                );
              }
            }
          }

          post({ type: 'progress', payload: { collected: rawLeads.length, saved } });
        };

        // ── Create + run crawler ──────────────────────────────────────────────
        crawler = await createCrawler({
          jobId: data.jobId,
          proxyPort,
          onChallengeDetected,
          onPageReady,
        });

        // Phase 8: SPA hash routing — use #/people so Apollo's router processes the URL
        const result = await crawler.run([{
          url: 'https://app.apollo.io/#/people?search[title]=engineer&search[locations][]=United+States',
        }]);

        // crawler.run() resolves even when requests fail (only rejects on queue timeout).
        // If requestsFailed > 0 or no requests finished, treat as extraction failure so the
        // retry loop can rotate proxy and try again.
        const { requestsFinished, requestsFailed } = result;
        if (requestsFailed > 0 || requestsFinished === 0) {
          throw new Error(
            `Extraction failed: ${requestsFinished} finished, ${requestsFailed} failed for job ${data.jobId}`,
          );
        }

        logger.info({ jobId: data.jobId, saved }, 'Extraction completed successfully');
        break;

      } catch (err) {
        if (err instanceof ChallengeBypassSignal) {
          const challengeType = err.challengeType;
          const url = err.url;
          logger.warn(
            { jobId: data.jobId, challengeType, url, proxyPort },
            'ChallengeBypassSignal — rotating proxy port',
          );
          proxyPort++;
          failCount = 0;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ jobId: data.jobId, err: msg }, 'Extraction error');

          failCount++;
          if (failCount >= MAX_RETRIES) {
            logger.warn({ jobId: data.jobId, failCount }, 'Max failures reached — rotating proxy');
            proxyPort++;
            failCount = 0;
          }
        }

        if (proxyPort > 65_535) {
          throw new Error(`Proxy port exhausted — all ports used for job ${data.jobId}`);
        }

        continue;
      } finally {
        if (crawler) {
          try {
            await crawler.teardown();
          } catch {
            // non-fatal teardown error
          }
        }
      }
    }

    // ── Export results from DB ─────────────────────────────────────────────
    const filePaths = await exportLeads(data.jobId);

    logger.info({ jobId: data.jobId, saved, filePaths }, 'Export completed');

    post({
      type: 'done',
      payload: { exportedAt: new Date().toISOString(), filePaths },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error({ err: message, stack }, 'Worker failed');
    post({ type: 'error', payload: { message, stack } });
  } finally {
    await prisma.$disconnect();
  }
}

run();
