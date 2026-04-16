import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page, Request } from 'playwright';
import { configureApolloPage } from './apollo-browser';
import { launchApolloContext } from './browser-launch';
import { attachPageDiagnostics } from './browser-diagnostics';
import { mutateHashScript } from './browser-context';
import { detectChallenge, type ChallengeDetection } from './challenge-detector';
import { ApolloResponseError, type ApolloResponseMeta, SessionTrustError } from './errors';
import { createApolloClient, extractSessionAuth, postApolloJson } from './extractor';
import { parseApolloMetadataResponse } from './leads-scraper';
import { logger } from './logger';
import { runApolloSessionPreflight, warmupApolloSession } from './session-preflight';
import { AuthManager } from './services/auth.service';

export interface CrawlerDeps {
  jobId: string;
  onChallengeDetected?: (detection: ChallengeDetection, url: string, page: Page) => void | Promise<void>;
  onPeopleResponse?: (payload: unknown, responseMeta: ApolloResponseMeta, page: Page, url: string) => void | Promise<void>;
}

export interface ManagedCrawler {
  run: (requests: Array<{ url: string; uniqueKey?: string; userData?: { targetUrl?: string } }>) => Promise<{ requestsFinished: number; requestsFailed: number }>;
  teardown: () => Promise<void>;
  consumeTerminalError: () => Error | null;
}

interface ApolloRequestCapture {
  headers: Record<string, string>;
  method: string;
  postDataJson: unknown;
  requestUrl: string;
  responsePath: string;
}

interface ApolloPeopleApiResponse {
  payload: unknown;
  responseMeta: ApolloResponseMeta;
}

type ApolloPeopleApiResult =
  | { ok: true; value: ApolloPeopleApiResponse }
  | { ok: false; error: unknown };

const PEOPLE_RESPONSE_TIMEOUT_MS = 180_000;
const APOLLO_SETTLE_TIMEOUT_MS = 10_000;
const INLINE_CHALLENGE_ATTEMPTS = 2;

function extractChallengeSitekey(text: string): string | null {
  const match = text.match(/data-sitekey=["']([^"']+)["']/i);
  return match?.[1] ?? null;
}

function detectChallengeTypeFromText(text: string): { challengeType: string | null; challengeSitekey: string | null } {
  const normalized = text.toLowerCase();
  const challengeSitekey = extractChallengeSitekey(text);

  if (normalized.includes('cf-turnstile') || normalized.includes('turnstile')) {
    return { challengeType: 'turnstile', challengeSitekey };
  }

  if (
    normalized.includes('challenges.cloudflare.com')
    || normalized.includes('cf-chl')
    || normalized.includes('cloudflare')
    || normalized.includes('verify you are a human')
    || normalized.includes('checking your browser')
  ) {
    return { challengeType: 'cloudflare', challengeSitekey };
  }

  if (
    normalized.includes('datadome')
    || normalized.includes('captcha-delivery.com')
  ) {
    return { challengeType: 'datadome', challengeSitekey };
  }

  if (
    normalized.includes('recaptcha')
    || normalized.includes('g-recaptcha')
  ) {
    return { challengeType: 'recaptcha', challengeSitekey };
  }

  if (
    normalized.includes('access denied')
    || normalized.includes('forbidden')
    || normalized.includes('too many requests')
    || normalized.includes('rate limit')
    || normalized.includes('unusual traffic')
    || normalized.includes('blocked')
  ) {
    return { challengeType: 'generic_block', challengeSitekey };
  }

  return { challengeType: null, challengeSitekey };
}

function buildResponseMeta(responseUrl: string, status: number, contentType: string, bodyText: string, challengeSitekey?: string | null): ApolloResponseMeta {
  return {
    responseUrl,
    status,
    contentType,
    bodyPreview: bodyText.slice(0, 500),
    challengeSitekey,
  };
}

function extractResponsePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function readRequestHeaders(request: Request): Promise<Record<string, string>> {
  try {
    return await request.allHeaders();
  } catch {
    return request.headers();
  }
}

function parseRequestJson(request: Request): unknown {
  const postData = request.postData();
  if (!postData) {
    return {};
  }

  try {
    return JSON.parse(postData) as unknown;
  } catch {
    return {};
  }
}

async function captureDebugScreenshot(page: Page, jobId: string, suffix: string): Promise<string | null> {
  try {
    const logsDir = path.resolve('logs');
    await mkdir(logsDir, { recursive: true });
    const filePath = path.join(logsDir, `${jobId}-${suffix}-${Date.now()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch (err) {
    logger.warn({ jobId, err: err instanceof Error ? err.message : String(err) }, 'Failed to capture debug screenshot');
    return null;
  }
}

async function navigateToTarget(page: Page, jobId: string, targetUrl: string): Promise<void> {
  const target = new URL(targetUrl);
  const targetHash = target.hash || '#/people';
  const targetHref = target.toString();

  logger.info({ jobId, currentUrl: page.url(), targetHash, targetHref }, 'Navigating Apollo app to people route');

  if (!page.url().includes('app.apollo.io')) {
    throw new Error(`Apollo app context missing after auth: ${page.url()}`);
  }

  if (page.url().includes('/#/login')) {
    throw new Error('Apollo redirected back to login after authentication');
  }

  try {
    await page.goto(targetHref, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
  } catch (err) {
    logger.warn(
      { jobId, currentUrl: page.url(), targetHref, err: err instanceof Error ? err.message : String(err) },
      'Direct Apollo route navigation failed, falling back to hash mutation',
    );

    await page.evaluate(mutateHashScript, targetHash);
  }

  await page.waitForFunction(
    "window.location.hash.startsWith('#/people') || window.location.pathname === '/people'",
    undefined,
    { timeout: 60_000 },
  );

  await page.waitForLoadState('networkidle', { timeout: APOLLO_SETTLE_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  logger.info({ jobId, currentUrl: page.url(), targetHash, targetHref }, 'Apollo people route requested');
}

async function replayPeopleSearch(jobId: string, page: Page, requestCapture: ApolloRequestCapture): Promise<ApolloPeopleApiResponse> {
  const auth = await extractSessionAuth(page);
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const client = await createApolloClient({
    jobId,
    auth,
    requestHeaders: requestCapture.headers,
    refererUrl: page.url(),
    userAgent,
  });

  logger.info(
    {
      jobId,
      requestUrl: requestCapture.requestUrl,
      responsePath: requestCapture.responsePath,
    },
    'Replaying canonical Apollo people search request',
  );

  const replay = await postApolloJson(client, 'api/v1/mixed_people/search', requestCapture.postDataJson);
  const responseMeta = buildResponseMeta(
    replay.responseUrl,
    replay.status,
    replay.contentType,
    replay.rawBody,
    null,
  );

  return {
    payload: replay.payload,
    responseMeta,
  };
}

async function waitForApolloPeoplePayload(page: Page, jobId: string): Promise<ApolloPeopleApiResponse> {
  const deadline = Date.now() + PEOPLE_RESPONSE_TIMEOUT_MS;
  let replayAttempted = false;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const response = await page.waitForResponse(
      candidate => (
        candidate.request().method() === 'POST'
        && candidate.url().includes('/api/v1/mixed_people/search')
      ),
      { timeout: remainingMs },
    );

    const request = response.request();
    const responsePath = extractResponsePath(response.url());
    const requestCapture: ApolloRequestCapture = {
      headers: await readRequestHeaders(request),
      method: request.method(),
      postDataJson: parseRequestJson(request),
      requestUrl: request.url(),
      responsePath,
    };

    const contentType = response.headers()['content-type'] ?? '';
    const bodyText = await response.text().catch(() => '');
    const { challengeType, challengeSitekey } = detectChallengeTypeFromText(`${contentType}\n${bodyText}`);
    const responseMeta = buildResponseMeta(response.url(), response.status(), contentType, bodyText, challengeSitekey);

    if (!contentType.includes('application/json')) {
      logger.warn(
        {
          jobId,
          ...responseMeta,
          challengeType,
        },
        'Apollo people response is non-JSON',
      );

      if (challengeType) {
        throw new ApolloResponseError(
          `Apollo people response looks like ${challengeType} challenge`,
          responseMeta,
          ['Non-JSON response returned for /api/v1/mixed_people/search'],
          challengeType,
        );
      }

      throw new ApolloResponseError(
        'Apollo people response is non-JSON',
        responseMeta,
        ['Non-JSON response returned for /api/v1/mixed_people/search'],
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyText) as unknown;
    } catch (err) {
      logger.warn(
        {
          jobId,
          ...responseMeta,
          challengeType,
          err: err instanceof Error ? err.message : String(err),
        },
        'Apollo people response contains invalid JSON',
      );

      throw new ApolloResponseError(
        challengeType
          ? `Apollo people response contains invalid JSON and looks like ${challengeType} challenge`
          : 'Apollo people response contains invalid JSON',
        responseMeta,
        ['Invalid JSON returned for /api/v1/mixed_people/search'],
        challengeType,
      );
    }

    if (responsePath.endsWith('/search_metadata_mode')) {
      parseApolloMetadataResponse(jobId, payload, responseMeta);

      if (!replayAttempted) {
        replayAttempted = true;
        return replayPeopleSearch(jobId, page, requestCapture);
      }

      continue;
    }

    return {
      payload,
      responseMeta,
    };
  }

  throw new Error(`Apollo people search response not observed within ${PEOPLE_RESPONSE_TIMEOUT_MS}ms`);
}

export async function createCrawler(deps: CrawlerDeps): Promise<ManagedCrawler> {
  const { jobId, onChallengeDetected, onPeopleResponse } = deps;
  let browserContext: BrowserContext | null = null;
  let terminalError: Error | null = null;
  return {
    run: async requests => {
      try {
        const firstRequest = requests[0];
        if (!firstRequest) {
          throw new Error('Crawler run() requires at least one request');
        }

        const targetUrl = typeof firstRequest.userData?.targetUrl === 'string'
          ? firstRequest.userData.targetUrl
          : String(firstRequest.url);

        browserContext = await launchApolloContext(jobId);
        const page = browserContext.pages()[0] ?? await browserContext.newPage();

        attachPageDiagnostics(page, jobId);
        page.setDefaultNavigationTimeout(120_000);
        page.setDefaultTimeout(120_000);
        await configureApolloPage(page);
        await AuthManager.ensureAuthenticated(page, jobId);
        await warmupApolloSession(page, jobId);
        const sessionPreflight = await runApolloSessionPreflight(page);
        logger.info({ jobId, sessionPreflight }, 'Apollo session preflight completed');
        if (sessionPreflight.blockers.length > 0) {
          throw new SessionTrustError(
            `Apollo session is not stable enough for people search: ${sessionPreflight.blockers.join('; ')}`,
            sessionPreflight.blockers,
          );
        }

        let inlineChallengeAttempts = 0;

        while (true) {
          const peopleResponsePromise: Promise<ApolloPeopleApiResult> = waitForApolloPeoplePayload(page, jobId)
            .then<ApolloPeopleApiResult>(value => ({ ok: true, value }))
            .catch<ApolloPeopleApiResult>(error => ({ ok: false, error }));
          await navigateToTarget(page, jobId, targetUrl);

          const domDetection = await detectChallenge(page);
          if (domDetection.type !== null) {
            const result = onChallengeDetected?.(domDetection, targetUrl, page);
            if (result instanceof Promise) {
              await result;
            }

            if (
              (domDetection.type === 'recaptcha' || domDetection.type === 'turnstile')
              && inlineChallengeAttempts < INLINE_CHALLENGE_ATTEMPTS
            ) {
              inlineChallengeAttempts += 1;
              await page.waitForTimeout(3_000);
              continue;
            }
          }

          if (!onPeopleResponse) {
            return { requestsFinished: 1, requestsFailed: 0 };
          }

          try {
            const peopleResponseResult = await peopleResponsePromise;
            if (!peopleResponseResult.ok) {
              throw peopleResponseResult.error;
            }

            await onPeopleResponse(
              peopleResponseResult.value.payload,
              peopleResponseResult.value.responseMeta,
              page,
              targetUrl,
            );

            return { requestsFinished: 1, requestsFailed: 0 };
          } catch (err) {
            if (
              err instanceof ApolloResponseError
              && (err.challengeType === 'turnstile' || err.challengeType === 'recaptcha')
              && err.responseMeta.challengeSitekey
              && inlineChallengeAttempts < INLINE_CHALLENGE_ATTEMPTS
            ) {
              inlineChallengeAttempts += 1;
              const responseDetection: ChallengeDetection = {
                type: err.challengeType,
                sitekey: err.responseMeta.challengeSitekey,
                message: `Challenge detected in Apollo API response: ${err.challengeType}`,
              };
              const result = onChallengeDetected?.(responseDetection, err.responseMeta.responseUrl, page);
              if (result instanceof Promise) {
                await result;
              }
              await page.waitForTimeout(3_000);
              continue;
            }

            const screenshotPath = await captureDebugScreenshot(page, jobId, 'people-response-timeout');
            logger.error(
              {
                jobId,
                currentUrl: page.url(),
                targetUrl,
                screenshotPath,
                err: err instanceof Error ? err.message : String(err),
              },
              'Failed while waiting for Apollo people search response',
            );
            throw err;
          }
        }
      } catch (err) {
        terminalError = err instanceof Error ? err : new Error(String(err));
        return { requestsFinished: 0, requestsFailed: 1 };
      }
    },
    teardown: async () => {
      if (!browserContext) {
        return;
      }

      await browserContext.close();
      browserContext = null;
    },
    consumeTerminalError: () => {
      const currentError = terminalError;
      terminalError = null;
      return currentError;
    },
  };
}
