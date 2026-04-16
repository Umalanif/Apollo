import type { Page } from 'playwright';
import { readApolloSessionForensicsScript } from './browser-context';
import { extractSessionAuth } from './extractor';
import { logger } from './logger';

const SESSION_BLOCK_PATTERNS = [
  'for security reasons, microsoft logged the account out',
  'used from multiple places',
  'stay signed in',
  'angemeldet bleiben',
  'pick an account',
  'konto auswählen',
  'enter password',
  'kennwort eingeben',
  'sign in to your account',
  'bei ihrem konto anmelden',
  'verify your identity',
  'identität überprüfen',
];
const APOLLO_WARMUP_TIMEOUT_MS = 20_000;
const APOLLO_WARMUP_POLL_MS = 1_000;

export interface ApolloSessionPreflight {
  pageUrl: string;
  pageTitle: string;
  csrfTokenPresent: boolean;
  apolloCookieCount: number;
  hasMicrosoftInterstitial: boolean;
  blockers: string[];
}

function isApolloAppUrl(url: string): boolean {
  return /app\.apollo\.io/i.test(url) && !/\/#\/login\b/i.test(url);
}

export async function warmupApolloSession(page: Page, jobId: string): Promise<void> {
  const deadline = Date.now() + APOLLO_WARMUP_TIMEOUT_MS;
  let lastObservedCsrf = '';
  let lastCookieCount = 0;

  while (Date.now() < deadline) {
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);

    const auth = await extractSessionAuth(page);
    const cookies = await page.context().cookies(page.url().includes('apollo.io') ? page.url() : 'https://app.apollo.io/');
    const apolloCookieCount = cookies.filter(cookie => cookie.domain === 'apollo.io' || cookie.domain.endsWith('.apollo.io')).length;

    lastObservedCsrf = auth.csrfToken;
    lastCookieCount = apolloCookieCount;

    if (auth.csrfToken && apolloCookieCount > 0) {
      logger.info(
        { jobId, currentUrl: page.url(), apolloCookieCount },
        'Apollo session warmup completed',
      );
      return;
    }

    await page.waitForTimeout(APOLLO_WARMUP_POLL_MS);
  }

  const forensicSnapshot = await page.evaluate(readApolloSessionForensicsScript).catch(() => null);
  logger.warn(
    {
      jobId,
      currentUrl: page.url(),
      lastObservedCsrfPresent: Boolean(lastObservedCsrf),
      lastApolloCookieCount: lastCookieCount,
      forensicSnapshot,
    },
    'Apollo session warmup ended without CSRF token',
  );
}

export async function runApolloSessionPreflight(page: Page): Promise<ApolloSessionPreflight> {
  const pageState = await page.evaluate(() => {
    const bodyText = (document.body?.innerText ?? '').toLowerCase();
    return {
      url: window.location.href,
      title: document.title ?? '',
      bodyText,
    };
  });

  const sessionAuth = await extractSessionAuth(page);
  const cookies = await page.context().cookies(pageState.url.includes('apollo.io') ? pageState.url : 'https://app.apollo.io/');
  const apolloCookies = cookies.filter(cookie => cookie.domain === 'apollo.io' || cookie.domain.endsWith('.apollo.io'));
  const blockers: string[] = [];
  const lowerUrl = pageState.url.toLowerCase();
  const lowerTitle = pageState.title.toLowerCase();
  const combinedText = `${lowerUrl}\n${lowerTitle}\n${pageState.bodyText}`;

  if (!isApolloAppUrl(pageState.url)) {
    blockers.push(`Apollo app route not active: ${pageState.url}`);
  }

  if (
    lowerUrl.includes('microsoft') ||
    lowerUrl.includes('login.live.com') ||
    lowerUrl.includes('microsoftonline.com')
  ) {
    blockers.push(`Microsoft interstitial still active: ${pageState.url}`);
  }

  for (const pattern of SESSION_BLOCK_PATTERNS) {
    if (combinedText.includes(pattern)) {
      blockers.push(`Session page still shows auth/interstitial marker: ${pattern}`);
    }
  }

  if (!sessionAuth.csrfToken) {
    blockers.push('CSRF token missing from Apollo page');
  }

  if (apolloCookies.length === 0) {
    blockers.push('No apollo.io cookies present in browser context');
  }

  return {
    pageUrl: pageState.url,
    pageTitle: pageState.title,
    csrfTokenPresent: Boolean(sessionAuth.csrfToken),
    apolloCookieCount: apolloCookies.length,
    hasMicrosoftInterstitial: blockers.some(blocker => blocker.includes('Microsoft') || blocker.includes('auth/interstitial')),
    blockers: [...new Set(blockers)],
  };
}
