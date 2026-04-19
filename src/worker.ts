import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Page } from 'playwright';
import { isMainThread, parentPort, workerData } from 'worker_threads';
import { readManualChallengeStateScript } from './browser-context';
import type { ChallengeDetection } from './challenge-detector';
import { createCrawler } from './crawler';
import { saveLead } from './db/db.service';
import {
  ApolloResponseError,
  type ApolloResponseMeta,
  AuthenticationError,
  ChallengeBypassSignal,
  EnvironmentTrustError,
  QueryTooBroadError,
  SessionTrustError,
} from './errors';
import { exportLeads } from './export';
import { parseApolloPeopleResponse } from './leads-scraper';
import { logger } from './logger';
import { APOLLO_LOGIN_URL } from './apollo-browser';
import { isTargetClosedError, safePageEvaluate, safePageUrl } from './playwright-helpers';
import { getProxyConfig } from './proxy';
import type { Targeting } from './targeting';

export interface WorkerData {
  jobId: string;
  targeting: Targeting;
  maxLeads?: number;
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
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const closedMessage = `Browser page was closed while waiting for manual ${challengeType} challenge resolution`;

  logger.warn(
    { jobId, challengeType, timeoutMs },
    'CAPTCHA_REQUIRED',
  );

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      throw new EnvironmentTrustError(closedMessage, 'manual_challenge_page_closed');
    }

    const detection = await safePageEvaluate<{
      hasTurnstile: boolean;
      hasCloudflare: boolean;
      currentUrl: string;
    }>(page, readManualChallengeStateScript);
    if (!detection) {
      throw new EnvironmentTrustError(closedMessage, 'manual_challenge_page_closed');
    }

    if (!detection.hasTurnstile && !detection.hasCloudflare) {
      logger.info(
        { jobId, challengeType, currentUrl: detection.currentUrl },
        'Manual CAPTCHA appears cleared; resuming worker flow',
      );
      return;
    }

    await sleep(2_000);
  }

  throw new EnvironmentTrustError(
    `Timed out waiting for manual ${challengeType} challenge resolution`,
    'manual_challenge_timeout',
  );
}

export function buildPeopleSearchUrl(targeting: WorkerData['targeting']): string {
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

  for (const seniority of targeting.seniorities ?? []) {
    params.append('search[person_seniorities][]', seniority);
  }

  for (const employeeRange of targeting.organizationNumEmployeesRanges ?? []) {
    params.append('search[organization_num_employees_ranges][]', employeeRange);
  }

  for (const industryTagId of targeting.organizationIndustryTagIds ?? []) {
    params.append('search[organization_industry_tag_ids][]', industryTagId);
  }

  for (const industryKeyword of targeting.organizationIndustryKeywords ?? []) {
    params.append('search[q_organization_industry_keywords][]', industryKeyword);
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
    const TRUST_COOLDOWN_MS = Number(process.env.APOLLO_TRUST_COOLDOWN_MS ?? 15_000);
    const { host: proxyHost, port: proxyPort } = getProxyConfig();
    let failCount = 0;
    let challengeRetryCount = 0;
    let launchAttempt = 0;
    let saved = 0;
    const maxLeads = typeof data.maxLeads === 'number' && data.maxLeads > 0
      ? Math.floor(data.maxLeads)
      : null;

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
        launchAttempt += 1;
        const onChallengeDetected = async (
          detection: ChallengeDetection,
          url: string,
          page: Page,
        ): Promise<void> => {
          logger.warn(
            { jobId: data.jobId, challengeType: detection.type, url },
            `Challenge detected: ${detection.message}`,
          );

          if (detection.type === 'turnstile' || detection.type === 'cloudflare') {
            await waitForManualChallengeResolution(page, data.jobId, detection.type);
            const challengeState = await safePageEvaluate<{
              hasTurnstile: boolean;
              hasCloudflare: boolean;
            }>(page, readManualChallengeStateScript);
            if (challengeState?.hasTurnstile || challengeState?.hasCloudflare) {
              throw new EnvironmentTrustError(
                `Manual ${detection.type} challenge wait finished but challenge is still present`,
                'challenge_still_present',
              );
            }
            failCount = 0;
            return;
          }
          throw new ChallengeBypassSignal(detection.type ?? 'unknown', url);
        };

        const onPeopleResponse = async (
          payload: unknown,
          responseMeta: ApolloResponseMeta,
          page: Page,
          url: string,
        ): Promise<void> => {
          logger.debug(
            { jobId: data.jobId, url, currentUrl: safePageUrl(page), responseMeta },
            'Processing intercepted Apollo response',
          );

          const leads = parseApolloPeopleResponse(data.jobId, payload, responseMeta);
          for (const lead of leads) {
            if (maxLeads !== null && saved >= maxLeads) {
              logger.info({ jobId: data.jobId, saved, maxLeads }, 'Lead save limit reached; skipping remaining leads');
              break;
            }

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

          post({ type: 'progress', payload: { collected: Math.min(leads.length, maxLeads ?? leads.length), saved } });
        };

        activeCrawler = await createCrawler({
          jobId: data.jobId,
          launchAttempt,
          forceFreshProfile: challengeRetryCount > 0,
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

          if (challengeRetryCount >= MAX_CHALLENGE_RETRIES) {
            throw new Error(
              `Environment trust failure persisted after ${challengeRetryCount} attempts on proxy ${proxyHost}:${proxyPort}: ${err.message}`,
            );
          }

          failCount = 0;
          await sleep(TRUST_COOLDOWN_MS * challengeRetryCount);
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
          if (err instanceof QueryTooBroadError) {
            logger.error(
              {
                jobId: data.jobId,
                code: err.code,
                threshold: err.threshold,
                totalEntries: err.totalEntries,
                pipelineTotal: err.pipelineTotal,
                responseMeta: err.responseMeta,
                validationErrors: err.validationErrors,
              },
              'FATAL: APOLLO_QUERY_TOO_BROAD',
            );
            post({ type: 'error', payload: { message: err.message } });
            return;
          }

          logger.error(
            {
              jobId: data.jobId,
              challengeType: err.challengeType,
              challengeSource: err.challengeSource,
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
        if (isTargetClosedError(err)) {
          logger.warn({ jobId: data.jobId, launchAttempt, proxyPort }, 'Target closed during worker run; relaunching fresh browser profile');
        }
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

export function createWorkerJobData(
  targeting: WorkerData['targeting'],
  jobId = `apollo-${randomUUID()}`,
  maxLeads?: number,
): WorkerData {
  return {
    jobId,
    targeting,
    maxLeads,
  };
}

if (!isMainThread) {
  void runWorkerJob(workerData as WorkerData);
}
