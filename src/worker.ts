import { PrismaClient } from '@prisma/client';
import type { Page } from 'playwright';
import { parentPort, workerData } from 'worker_threads';
import { solveRecaptcha } from './captcha-solver';
import type { ChallengeDetection } from './challenge-detector';
import { createCrawler } from './crawler';
import { saveLead } from './db/db.service';
import { AuthenticationError, ChallengeBypassSignal } from './errors';
import { exportLeads } from './export';
import { parseApolloPeopleResponse } from './leads-scraper';
import { logger } from './logger';
import { APOLLO_LOGIN_URL } from './apollo-browser';

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

function post(msg: OutgoingMessage): void {
  parentPort?.postMessage(msg);
}

function buildPeopleSearchUrl(targeting: WorkerData['targeting']): string {
  const params = new URLSearchParams();

  for (const keyword of targeting.keywords ?? []) {
    params.append('search[keywords][]', keyword);
  }

  for (const title of targeting.titles ?? []) {
    params.append('search[person_titles][]', title);
  }

  for (const location of targeting.locations ?? []) {
    params.append('search[person_locations][]', location);
  }

  for (const company of targeting.companies ?? []) {
    params.append('search[organization_names][]', company);
  }

  const query = params.toString();
  return `https://app.apollo.io/#/people${query ? `?${query}` : ''}`;
}

async function teardownCrawler(crawler: Awaited<ReturnType<typeof createCrawler>> | null): Promise<void> {
  if (!crawler) {
    return;
  }

  try {
    await crawler.teardown();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Crawler teardown failed');
  }
}

async function run(): Promise<void> {
  const prisma = new PrismaClient();
  let activeCrawler: Awaited<ReturnType<typeof createCrawler>> | null = null;
  let shuttingDown = false;
  const data = workerData as WorkerData;

  const shutdown = async (signal?: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ jobId: data?.jobId, signal }, 'Worker shutdown started');
    await teardownCrawler(activeCrawler);
    await prisma.$disconnect();
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT').then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').then(() => process.exit(0));
  });

  if (!data?.jobId) {
    const message = 'workerData.jobId is required';
    logger.error({ err: message }, 'Invalid worker data');
    post({ type: 'error', payload: { message } });
    await shutdown();
    return;
  }

  logger.info({ jobId: data.jobId, targeting: data.targeting }, 'Worker started');
  post({ type: 'progress', payload: { collected: 0, saved: 0 } });

  try {
    const MAX_RETRIES = 3;
    let proxyPort = 10_000;
    let failCount = 0;
    let saved = 0;

    while (true) {
      try {
        const onChallengeDetected = async (
          detection: ChallengeDetection,
          url: string,
          page: Page,
        ): Promise<void> => {
          logger.warn(
            { jobId: data.jobId, challengeType: detection.type, url },
            `Challenge detected: ${detection.message}`,
          );

          if (detection.type !== 'recaptcha') {
            throw new ChallengeBypassSignal(detection.type ?? 'unknown', url);
          }

          if (!detection.sitekey) {
            throw new ChallengeBypassSignal('recaptcha', url);
          }

          const token = await solveRecaptcha(detection.sitekey, url);
          await page.evaluate((captchaToken: string) => {
            const textarea = document.querySelector<HTMLTextAreaElement>('#g-recaptcha-response');
            if (textarea) {
              textarea.value = captchaToken;
            }

            document.dispatchEvent(new CustomEvent('recaptcha-token-ready', {
              detail: { token: captchaToken },
            }));
          }, token);

          failCount = 0;
        };

        const onPeopleResponse = async (payload: unknown, page: Page, url: string): Promise<void> => {
          logger.debug({ jobId: data.jobId, url, currentUrl: page.url() }, 'Processing intercepted Apollo response');

          const leads = parseApolloPeopleResponse(data.jobId, payload);
          for (const lead of leads) {
            try {
              await saveLead(prisma, data.jobId, lead);
              saved++;
            } catch (err) {
              if (err instanceof Error && !err.message.includes('Invalid lead data')) {
                logger.warn(
                  { jobId: data.jobId, err: err.message, linkedInUrl: lead.linkedInUrl },
                  'saveLead error',
                );
              }
            }
          }

          post({ type: 'progress', payload: { collected: leads.length, saved } });
        };

        activeCrawler = await createCrawler({
          jobId: data.jobId,
          proxyPort,
          onChallengeDetected,
          onPeopleResponse,
        });

        const targetUrl = buildPeopleSearchUrl(data.targeting);
        const result = await activeCrawler.run([{
          url: APOLLO_LOGIN_URL,
          uniqueKey: `${data.jobId}:apollo-login`,
          userData: { targetUrl },
        }]);
        if (result.requestsFailed > 0 || result.requestsFinished === 0) {
          throw new Error(
            `Extraction failed: ${result.requestsFinished} finished, ${result.requestsFailed} failed for job ${data.jobId}`,
          );
        }

        logger.info({ jobId: data.jobId, saved }, 'Extraction completed successfully');
        break;
      } catch (err) {
        if (err instanceof AuthenticationError) {
          logger.error({ jobId: data.jobId, err: err.message }, 'FATAL: AUTH_FAILED');
          post({ type: 'error', payload: { message: err.message } });
          return;
        }

        if (err instanceof ChallengeBypassSignal) {
          logger.warn(
            { jobId: data.jobId, challengeType: err.challengeType, url: err.url, proxyPort },
            'ChallengeBypassSignal — rotating proxy port',
          );
          proxyPort++;
          failCount = 0;
        } else {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ jobId: data.jobId, err: message }, 'Extraction error');
          failCount++;
          if (failCount >= MAX_RETRIES) {
            logger.warn({ jobId: data.jobId, failCount }, 'Max failures reached — rotating proxy');
            proxyPort++;
            failCount = 0;
          }
        }

        if (proxyPort > 65_535) {
          throw new Error(`Proxy port exhausted for job ${data.jobId}`);
        }
      } finally {
        await teardownCrawler(activeCrawler);
        activeCrawler = null;
      }
    }

    const filePaths = await exportLeads(prisma, data.jobId);
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
    await shutdown();
  }
}

void run();
