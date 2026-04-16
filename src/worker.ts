import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Page } from 'playwright';
import { isMainThread, parentPort, workerData } from 'worker_threads';
import { getApolloBrowserConfig } from './browser-config';
import {
  injectChallengeTokenScript,
  readManualChallengeStateScript,
  readTurnstileWidgetStateScript,
} from './browser-context';
import { recordChallengeForensics, resolveTurnstilePageUrl } from './challenge-forensics';
import { solveCloudflareTurnstile, solveRecaptcha } from './captcha-solver';
import type { ChallengeDetection } from './challenge-detector';
import { createCrawler } from './crawler';
import { saveLead } from './db/db.service';
import {
  ApolloResponseError,
  type ApolloResponseMeta,
  AuthenticationError,
  ChallengeBypassSignal,
  EnvironmentTrustError,
  SessionTrustError,
} from './errors';
import { exportLeads } from './export';
import { parseApolloPeopleResponse } from './leads-scraper';
import { logger } from './logger';
import { APOLLO_LOGIN_URL } from './apollo-browser';
import { getProxyConfig } from './proxy';

export interface WorkerData {
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function waitForManualChallengeResolution(
  page: Page,
  jobId: string,
  challengeType: string,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  logger.warn(
    { jobId, challengeType, timeoutMs },
    'Manual CAPTCHA step required in browser; waiting for challenge to be cleared',
  );

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      throw new Error('Browser page was closed while waiting for manual CAPTCHA resolution');
    }

    const detection = await page.evaluate(readManualChallengeStateScript);

    if (!detection.hasTurnstile && !detection.hasCloudflare) {
      logger.info(
        { jobId, challengeType, currentUrl: detection.currentUrl },
        'Manual CAPTCHA appears cleared; resuming worker flow',
      );
      return;
    }

    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for manual ${challengeType} challenge resolution`);
}

async function injectChallengeToken(page: Page, token: string): Promise<void> {
  await page.evaluate(injectChallengeTokenScript, token);
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

export async function runWorkerJob(data: WorkerData): Promise<void> {
  const prisma = new PrismaClient();
  let activeCrawler: Awaited<ReturnType<typeof createCrawler>> | null = null;
  let shuttingDown = false;
  const browserConfig = getApolloBrowserConfig();

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
    const MAX_CHALLENGE_RETRIES = 3;
    const CHALLENGE_RETRY_DELAY_MS = 5_000;
    const { host: proxyHost, port: proxyPort } = getProxyConfig();
    let failCount = 0;
    let challengeRetryCount = 0;
    let saved = 0;

    logger.info(
      {
        jobId: data.jobId,
        proxyHost,
        proxyPort,
        proxySource: 'env.PROXY_*',
      },
      'Resolved worker proxy configuration',
    );

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

          if (detection.type === 'turnstile') {
            const preSolveRecord = await recordChallengeForensics({
              page,
              jobId: data.jobId,
              detection,
              solveMode: detection.sitekey ? '2captcha' : 'manual',
              phase: 'before-solve',
              browserConfig,
              fallbackUrl: url,
            });
            const turnstileState = await page.evaluate(readTurnstileWidgetStateScript);
            const sitekey = detection.sitekey ?? turnstileState.sitekey;

            if (!sitekey) {
              await waitForManualChallengeResolution(page, data.jobId, 'turnstile');
              const afterRecord = await recordChallengeForensics({
                page,
                jobId: data.jobId,
                detection,
                solveMode: 'manual',
                phase: 'after-solve',
                browserConfig,
                fallbackUrl: url,
              });
              if (afterRecord.outcome !== 'challenge_cleared') {
                throw new EnvironmentTrustError(
                  `Manual Turnstile solve did not clear the challenge (${afterRecord.outcome})`,
                  afterRecord.outcome,
                );
              }
              failCount = 0;
              return;
            }

            const userAgent = await page.evaluate(() => navigator.userAgent);
            const resolvedPageUrl = resolveTurnstilePageUrl({
              fallbackUrl: url,
              topLevelPageUrl: preSolveRecord.topLevelPageUrl,
              challengeFrameUrl: preSolveRecord.challengeFrameUrl,
              challengeIframeSrc: preSolveRecord.challengeIframeSrc,
            });
            const token = await solveCloudflareTurnstile(sitekey, resolvedPageUrl.pageUrl, {
              extraOptions: {
                action: turnstileState.action ?? undefined,
                data: turnstileState.cData ?? undefined,
                pagedata: turnstileState.chlPageData ?? undefined,
                useragent: userAgent,
              },
            });
            await injectChallengeToken(page, token);
            await page.waitForTimeout(3_000);
            const afterRecord = await recordChallengeForensics({
              page,
              jobId: data.jobId,
              detection,
              solveMode: '2captcha',
              phase: 'after-solve',
              browserConfig,
              fallbackUrl: resolvedPageUrl.pageUrl,
            });
            if (afterRecord.outcome === 'verification_failed' || afterRecord.outcome === 'challenge_still_present') {
              throw new EnvironmentTrustError(
                `Turnstile token injection completed but Apollo still failed trust checks (${afterRecord.outcome})`,
                afterRecord.outcome,
              );
            }
            failCount = 0;
            return;
          }

          if (detection.type === 'cloudflare') {
            await waitForManualChallengeResolution(page, data.jobId, 'cloudflare');
            const afterRecord = await recordChallengeForensics({
              page,
              jobId: data.jobId,
              detection,
              solveMode: 'manual',
              phase: 'after-solve',
              browserConfig,
              fallbackUrl: url,
            });
            if (afterRecord.outcome !== 'challenge_cleared') {
              throw new EnvironmentTrustError(
                `Cloudflare interstitial did not clear after manual solve (${afterRecord.outcome})`,
                afterRecord.outcome,
              );
            }
            failCount = 0;
            return;
          }

          if (detection.type !== 'recaptcha') {
            throw new ChallengeBypassSignal(detection.type ?? 'unknown', url);
          }

          if (!detection.sitekey) {
            throw new ChallengeBypassSignal('recaptcha', url);
          }

          const userAgent = await page.evaluate(() => navigator.userAgent);
          const token = await solveRecaptcha(detection.sitekey, url, { userAgent });
          await injectChallengeToken(page, token);
          await page.waitForTimeout(3_000);

          failCount = 0;
        };

        const onPeopleResponse = async (
          payload: unknown,
          responseMeta: ApolloResponseMeta,
          page: Page,
          url: string,
        ): Promise<void> => {
          logger.debug(
            { jobId: data.jobId, url, currentUrl: page.url(), responseMeta },
            'Processing intercepted Apollo response',
          );

          const leads = parseApolloPeopleResponse(data.jobId, payload, responseMeta);
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
          onChallengeDetected,
          onPeopleResponse,
        });

        const targetUrl = buildPeopleSearchUrl(data.targeting);
        const result = await activeCrawler.run([{
          url: APOLLO_LOGIN_URL,
          uniqueKey: `${data.jobId}:apollo-login`,
          userData: { targetUrl },
        }]);
        const crawlerError = activeCrawler.consumeTerminalError();
        if (crawlerError) {
          throw crawlerError;
        }
        if (result.requestsFailed > 0 || result.requestsFinished === 0) {
          throw new Error(
            `Extraction failed: ${result.requestsFinished} finished, ${result.requestsFailed} failed for job ${data.jobId}`,
          );
        }

        challengeRetryCount = 0;
        logger.info({ jobId: data.jobId, saved, proxyPort }, 'Extraction completed successfully');
        break;
      } catch (err) {
        if (err instanceof AuthenticationError) {
          logger.error({ jobId: data.jobId, err: err.message }, 'FATAL: AUTH_FAILED');
          post({ type: 'error', payload: { message: err.message } });
          return;
        }

        if (err instanceof SessionTrustError) {
          logger.error({ jobId: data.jobId, blockers: err.blockers, err: err.message }, 'FATAL: SESSION_TRUST_FAILED');
          post({ type: 'error', payload: { message: err.message } });
          return;
        }

        if (err instanceof EnvironmentTrustError) {
          challengeRetryCount++;
          logger.error(
            {
              jobId: data.jobId,
              outcome: err.outcome,
              proxyPort,
              challengeRetryCount,
              maxChallengeRetries: MAX_CHALLENGE_RETRIES,
            },
            'Environment trust failure detected after challenge solve',
          );

          if (challengeRetryCount >= 2) {
            throw new Error(
              `Environment trust failure persisted after ${challengeRetryCount} attempts on proxy ${proxyHost}:${proxyPort}: ${err.message}`,
            );
          }

          failCount = 0;
          await sleep(CHALLENGE_RETRY_DELAY_MS * challengeRetryCount);
          continue;
        }

        if (err instanceof ChallengeBypassSignal) {
          challengeRetryCount++;
          logger.warn(
            {
              jobId: data.jobId,
              challengeType: err.challengeType,
              url: err.url,
              proxyPort,
              challengeRetryCount,
              maxChallengeRetries: MAX_CHALLENGE_RETRIES,
            },
            'ChallengeBypassSignal on Apollo flow',
          );

          if (challengeRetryCount >= MAX_CHALLENGE_RETRIES) {
            throw new Error(
              `Extraction failed after ${challengeRetryCount} challenge retries on proxy ${proxyHost}:${proxyPort}`,
            );
          }

          failCount = 0;
          await sleep(CHALLENGE_RETRY_DELAY_MS * challengeRetryCount);
          continue;
        }

        if (err instanceof ApolloResponseError) {
          logger.error(
            {
              jobId: data.jobId,
              challengeType: err.challengeType,
              responseMeta: err.responseMeta,
              validationErrors: err.validationErrors,
              proxyPort,
            },
            'Apollo people response was blocked or invalid',
          );

          if (err.challengeType) {
            challengeRetryCount++;
            logger.warn(
              {
                jobId: data.jobId,
                challengeType: err.challengeType,
                url: err.responseMeta.responseUrl,
                proxyPort,
                challengeRetryCount,
                maxChallengeRetries: MAX_CHALLENGE_RETRIES,
              },
              'Retrying after Apollo people challenge response',
            );

            if (challengeRetryCount >= MAX_CHALLENGE_RETRIES) {
              throw new Error(
                `Extraction failed after ${challengeRetryCount} challenge retries on proxy ${proxyHost}:${proxyPort}`,
              );
            }

            failCount = 0;
            await sleep(CHALLENGE_RETRY_DELAY_MS * challengeRetryCount);
            continue;
          }
        }

        challengeRetryCount = 0;
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ jobId: data.jobId, err: message, proxyPort }, 'Extraction error');
        failCount++;
        if (failCount >= MAX_RETRIES) {
          throw new Error(`Extraction failed after ${failCount} attempts on proxy ${proxyHost}:${proxyPort}`);
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

export function createWorkerJobData(targeting: WorkerData['targeting'], jobId = `apollo-${randomUUID()}`): WorkerData {
  return {
    jobId,
    targeting,
  };
}

if (!isMainThread) {
  void runWorkerJob(workerData as WorkerData);
}
