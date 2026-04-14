import { ProxyConfiguration } from '@crawlee/core';
import { PlaywrightCrawler } from 'crawlee';
import type { Page } from 'playwright';
import { APOLLO_PROXY_BYPASS_LIST, configureApolloPage } from './apollo-browser';
import { detectChallenge, type ChallengeDetection } from './challenge-detector';
import { ChallengeBypassSignal } from './errors';
import { getEnv } from './env/schema';
import { logger } from './logger';
import { AuthManager } from './services/auth.service';

export function buildProxyUrl(port: number = 10000): string {
  const { PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD } = getEnv();
  return `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_HOST}:${port}`;
}

export function getProxyComponents(port: number = 10000) {
  const { PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD } = getEnv();
  return {
    server: `http://${PROXY_HOST}:${port}`,
    username: PROXY_USERNAME,
    password: PROXY_PASSWORD,
  };
}

export interface CrawlerDeps {
  jobId: string;
  proxyPort?: number;
  onChallengeDetected?: (detection: ChallengeDetection, url: string, page: Page) => void | Promise<void>;
  onPeopleResponse?: (payload: unknown, page: Page, url: string) => void | Promise<void>;
}

export async function createCrawler(deps: CrawlerDeps): Promise<PlaywrightCrawler> {
  const { jobId, proxyPort = 10000, onChallengeDetected, onPeopleResponse } = deps;
  const { PROXY_HOST } = getEnv();
  const proxyComponents = getProxyComponents(proxyPort);

  logger.info(
    { jobId, proxyPort, proxyHost: `http://${PROXY_HOST}:${proxyPort}` },
    'Creating PlaywrightCrawler',
  );

  return new PlaywrightCrawler({
    maxConcurrency: 1,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 300,
    proxyConfiguration: new ProxyConfiguration({ proxyUrls: [buildProxyUrl(proxyPort)] }),
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
        { timeout: 60_000 },
      );
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });

      if (page.url().includes('/#/login')) {
        throw new Error('Apollo redirected back to login after authentication');
      }

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
        const response = await peopleResponsePromise;
        const payload = await response.json();
        await onPeopleResponse(payload, page, targetUrl);
      }
    },
    useSessionPool: false,
  });
}
