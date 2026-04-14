import { ProxyConfiguration } from '@crawlee/core';
import { PlaywrightCrawler } from 'crawlee';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { APOLLO_PROXY_BYPASS_LIST, configureApolloPage } from './apollo-browser';
import { detectChallenge, type ChallengeDetection } from './challenge-detector';
import { ChallengeBypassSignal } from './errors';
import { getEnv } from './env/schema';
import { logger } from './logger';
import { AuthManager } from './services/auth.service';

function sanitizeSessionKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function buildProxyUsername(sessionKey?: string): string {
  const { PROXY_USERNAME, PROXY_SESSION_KEY, PROXY_SESSION_TTL_MINUTES } = getEnv();
  sanitizeSessionKey(sessionKey ?? PROXY_SESSION_KEY);
  return `${PROXY_USERNAME}__sessttl.${PROXY_SESSION_TTL_MINUTES}`;
  // If DataImpulse support is later confirmed for combined sticky+session identifiers
  // on this port, append `;sessid.${stickySessionKey}` here.
}

export function buildProxyUrl(port?: number, sessionKey?: string): string {
  const { PROXY_HOST, PROXY_PASSWORD, PROXY_STICKY_PORT } = getEnv();
  const effectivePort = port ?? PROXY_STICKY_PORT;
  return `http://${buildProxyUsername(sessionKey)}:${PROXY_PASSWORD}@${PROXY_HOST}:${effectivePort}`;
}

export function getProxyComponents(port?: number, sessionKey?: string) {
  const { PROXY_HOST, PROXY_PASSWORD, PROXY_STICKY_PORT } = getEnv();
  const effectivePort = port ?? PROXY_STICKY_PORT;
  return {
    server: `http://${PROXY_HOST}:${effectivePort}`,
    username: buildProxyUsername(sessionKey),
    password: PROXY_PASSWORD,
  };
}

export interface CrawlerDeps {
  jobId: string;
  proxyPort?: number;
  proxySessionKey?: string;
  onChallengeDetected?: (detection: ChallengeDetection, url: string, page: Page) => void | Promise<void>;
  onPeopleResponse?: (payload: unknown, page: Page, url: string) => void | Promise<void>;
}

const PEOPLE_RESPONSE_TIMEOUT_MS = 180_000;
const APOLLO_SETTLE_TIMEOUT_MS = 10_000;

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

    await page.evaluate((hash: string) => {
      history.replaceState(null, '', hash);
      window.dispatchEvent(new HashChangeEvent('hashchange', {
        oldURL: window.location.href,
        newURL: window.location.origin + '/' + hash,
      }));
    }, targetHash);
  }

  await page.waitForFunction(
    () => window.location.hash.startsWith('#/people') || window.location.pathname === '/people',
    undefined,
    { timeout: 60_000 },
  );

  await page.waitForLoadState('networkidle', { timeout: APOLLO_SETTLE_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  logger.info({ jobId, currentUrl: page.url(), targetHash, targetHref }, 'Apollo people route requested');
}

export async function createCrawler(deps: CrawlerDeps): Promise<PlaywrightCrawler> {
  const { jobId, proxySessionKey, onChallengeDetected, onPeopleResponse } = deps;
  const { PROXY_HOST, PROXY_STICKY_PORT, PROXY_SESSION_TTL_MINUTES } = getEnv();
  const proxyPort = deps.proxyPort ?? PROXY_STICKY_PORT;
  const proxyComponents = getProxyComponents(proxyPort, proxySessionKey);

  logger.info(
    {
      jobId,
      proxyPort,
      proxyHost: `http://${PROXY_HOST}:${proxyPort}`,
      proxySessionKey,
      proxySessionTtlMinutes: PROXY_SESSION_TTL_MINUTES,
    },
    'Creating PlaywrightCrawler',
  );

  return new PlaywrightCrawler({
    maxConcurrency: 1,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 480,
    proxyConfiguration: new ProxyConfiguration({ proxyUrls: [buildProxyUrl(proxyPort, proxySessionKey)] }),
    launchContext: {
      launchOptions: {
        headless: false,
        slowMo: 250,
        proxy: {
          server: `http://${proxyComponents.server.replace('http://', '')}`,
          username: proxyComponents.username,
          password: proxyComponents.password,
        },
        args: [
          '--disable-blink-features=AutomationControlled',
          `--proxy-bypass-list=${APOLLO_PROXY_BYPASS_LIST}`,
        ],
      },
    },
    requestHandler: async ({ page, request }) => {
      const targetUrl = typeof request.userData?.targetUrl === 'string'
        ? request.userData.targetUrl
        : String(request.url);

      page.setDefaultNavigationTimeout(120_000);
      page.setDefaultTimeout(120_000);
      await configureApolloPage(page);

      page.on('requestfailed', req => {
        logger.warn(
          { jobId, url: req.url(), failure: req.failure()?.errorText ?? 'unknown' },
          'Request failed',
        );
      });

      await AuthManager.ensureAuthenticated(page, jobId);
      const peopleResponsePromise = page.waitForResponse(
        response => (
          response.request().method() === 'POST'
          && response.url().includes('/api/v1/mixed_people/search')
        ),
        { timeout: PEOPLE_RESPONSE_TIMEOUT_MS },
      );
      await navigateToTarget(page, jobId, targetUrl);

      let challengeSignal: Error | null = null;

      try {
        const detection = await detectChallenge(page);
        if (detection.type !== null) {
          const result = onChallengeDetected?.(detection, targetUrl, page);
          if (result instanceof Promise) {
            await result;
          }
        }
      } catch (err) {
        if (err instanceof ChallengeBypassSignal) {
          challengeSignal = err;
        } else {
          logger.debug({ jobId, err: String(err) }, 'Challenge detection error');
        }
      }

      if (challengeSignal) {
        throw challengeSignal;
      }

      if (onPeopleResponse) {
        let response;
        try {
          response = await peopleResponsePromise;
        } catch (err) {
          const screenshotPath = await captureDebugScreenshot(page, jobId, 'people-response-timeout');
          logger.error(
            {
              jobId,
              currentUrl: page.url(),
              targetUrl,
              screenshotPath,
              err: err instanceof Error ? err.message : String(err),
            },
            'Timed out waiting for Apollo people search response',
          );
          throw new Error(`Apollo people search response not observed within ${PEOPLE_RESPONSE_TIMEOUT_MS}ms`);
        }

        const payload = await response.json();
        await onPeopleResponse(payload, page, targetUrl);
      }
    },
    useSessionPool: false,
  });
}
