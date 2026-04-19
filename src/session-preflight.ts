import type { Page } from 'playwright';
import { readApolloSessionForensicsScript, readManualChallengeStateScript } from './browser-context';
import { extractSessionAuth } from './extractor';
import { logger } from './logger';
import { safePageCookies, safePageEvaluate, safePageUrl, safePageWaitForTimeout } from './playwright-helpers';

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
const CHALLENGE_FREE_QUIET_WINDOW_MS = 4_000;

export interface ApolloSessionPreflight {
  pageUrl: string;
  pageTitle: string;
  csrfTokenPresent: boolean;
  apolloCookieCount: number;
  apolloCookieNames: string[];
  cloudflareCookieNames: string[];
  hasCfBm: boolean;
  hasCfClearance: boolean;
  hasMicrosoftInterstitial: boolean;
  hasActiveChallenge: boolean;
  blockers: string[];
}

export interface ApolloWarmupResult {
  currentUrl: string | null;
  csrfTokenPresent: boolean;
  apolloCookieCount: number;
  apolloCookieNames: string[];
  cloudflareCookieNames: string[];
  hasCfBm: boolean;
  hasCfClearance: boolean;
  hasActiveChallenge: boolean;
  elapsedMs: number;
}

function isApolloAppUrl(url: string): boolean {
  return /app\.apollo\.io/i.test(url) && !/\/#\/login\b/i.test(url);
}

function summarizeApolloCookies(cookies: Array<{ domain: string; name: string }>): {
  apolloCookieCount: number;
  apolloCookieNames: string[];
  cloudflareCookieNames: string[];
  hasCfBm: boolean;
  hasCfClearance: boolean;
} {
  const apolloCookies = cookies.filter(cookie => cookie.domain === 'apollo.io' || cookie.domain.endsWith('.apollo.io'));
  const apolloCookieNames = [...new Set(apolloCookies.map(cookie => cookie.name))].sort();
  const cloudflareCookieNames = apolloCookieNames.filter(name => name.startsWith('__cf'));

  return {
    apolloCookieCount: apolloCookies.length,
    apolloCookieNames,
    cloudflareCookieNames,
    hasCfBm: apolloCookieNames.includes('__cf_bm'),
    hasCfClearance: apolloCookieNames.includes('cf_clearance'),
  };
}

function isApolloPeopleUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }

  return /app\.apollo\.io/i.test(url) && (url.includes('/#/people') || /\/people\b/i.test(url));
}

async function hasChallengeFreeQuietWindow(page: Page, quietWindowMs = CHALLENGE_FREE_QUIET_WINDOW_MS): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < quietWindowMs) {
    const challengeState = await safePageEvaluate<{
      hasTurnstile: boolean;
      hasCloudflare: boolean;
    }>(page, readManualChallengeStateScript);

    if (!challengeState || challengeState.hasTurnstile || challengeState.hasCloudflare) {
      return false;
    }

    await safePageWaitForTimeout(page, 500);
  }

  return true;
}

async function performHumanWarmupActivity(page: Page): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1440, height: 960 };
  const mousePath = [
    { x: Math.round(viewport.width * 0.34), y: Math.round(viewport.height * 0.22) },
    { x: Math.round(viewport.width * 0.58), y: Math.round(viewport.height * 0.28) },
    { x: Math.round(viewport.width * 0.47), y: Math.round(viewport.height * 0.61) },
  ];

  for (const point of mousePath) {
    if (page.isClosed()) {
      return;
    }

    await page.mouse.move(point.x, point.y, { steps: 20 }).catch(() => undefined);
    await safePageWaitForTimeout(page, 500);
  }

  await safePageEvaluate(page, () => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await safePageWaitForTimeout(page, 800);
  await safePageEvaluate(page, () => {
    window.scrollTo({ top: Math.min(window.innerHeight * 0.85, 700), behavior: 'instant' });
  });
  await safePageWaitForTimeout(page, 1200);
  await safePageEvaluate(page, () => {
    const hoverTarget = document.querySelector('button, a, [role="button"]') as HTMLElement | null;
    hoverTarget?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await safePageWaitForTimeout(page, 1000);
}

export async function warmupApolloSession(page: Page, jobId: string): Promise<ApolloWarmupResult> {
  const startedAt = Date.now();
  const deadline = startedAt + APOLLO_WARMUP_TIMEOUT_MS;
  let lastObservedCsrf = '';
  let lastCookieSummary = {
    apolloCookieCount: 0,
    apolloCookieNames: [] as string[],
    cloudflareCookieNames: [] as string[],
    hasCfBm: false,
    hasCfClearance: false,
  };
  let lastChallengePresent = false;

  while (Date.now() < deadline) {
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);

    const auth = await extractSessionAuth(page);
    const currentUrl = safePageUrl(page) ?? 'https://app.apollo.io/';
    const cookies = await safePageCookies(page, currentUrl.includes('apollo.io') ? currentUrl : 'https://app.apollo.io/');
    lastCookieSummary = summarizeApolloCookies(cookies);
    const challengeState = await safePageEvaluate<{
      hasTurnstile: boolean;
      hasCloudflare: boolean;
    }>(page, readManualChallengeStateScript);
    lastChallengePresent = Boolean(challengeState?.hasTurnstile || challengeState?.hasCloudflare);

    lastObservedCsrf = auth.csrfToken;

    if (
      auth.csrfToken
      && lastCookieSummary.apolloCookieCount > 0
      && isApolloPeopleUrl(currentUrl)
      && !lastChallengePresent
    ) {
      await performHumanWarmupActivity(page);
      const quietWindowPassed = await hasChallengeFreeQuietWindow(page);
      if (!quietWindowPassed) {
        await safePageWaitForTimeout(page, APOLLO_WARMUP_POLL_MS);
        continue;
      }

      const elapsedMs = Date.now() - startedAt;
      logger.info(
        {
          jobId,
          currentUrl,
          apolloCookieCount: lastCookieSummary.apolloCookieCount,
          apolloCookieNames: lastCookieSummary.apolloCookieNames,
          cloudflareCookieNames: lastCookieSummary.cloudflareCookieNames,
          hasCfBm: lastCookieSummary.hasCfBm,
          hasCfClearance: lastCookieSummary.hasCfClearance,
          hasActiveChallenge: false,
          elapsedMs,
        },
        'Apollo session warmup completed',
      );

      return {
        currentUrl,
        csrfTokenPresent: Boolean(auth.csrfToken),
        apolloCookieCount: lastCookieSummary.apolloCookieCount,
        apolloCookieNames: lastCookieSummary.apolloCookieNames,
        cloudflareCookieNames: lastCookieSummary.cloudflareCookieNames,
        hasCfBm: lastCookieSummary.hasCfBm,
        hasCfClearance: lastCookieSummary.hasCfClearance,
        hasActiveChallenge: false,
        elapsedMs,
      };
    }

    await page.waitForTimeout(APOLLO_WARMUP_POLL_MS);
  }

  const forensicSnapshot = await safePageEvaluate(page, readApolloSessionForensicsScript);
  const currentUrl = safePageUrl(page);
  const elapsedMs = Date.now() - startedAt;
  logger.warn(
    {
      jobId,
      currentUrl,
      lastObservedCsrfPresent: Boolean(lastObservedCsrf),
      lastApolloCookieCount: lastCookieSummary.apolloCookieCount,
      apolloCookieNames: lastCookieSummary.apolloCookieNames,
      cloudflareCookieNames: lastCookieSummary.cloudflareCookieNames,
      hasCfBm: lastCookieSummary.hasCfBm,
      hasCfClearance: lastCookieSummary.hasCfClearance,
      hasActiveChallenge: lastChallengePresent,
      elapsedMs,
      forensicSnapshot,
    },
    'Apollo session warmup ended without CSRF token',
  );

  return {
    currentUrl,
    csrfTokenPresent: Boolean(lastObservedCsrf),
    apolloCookieCount: lastCookieSummary.apolloCookieCount,
    apolloCookieNames: lastCookieSummary.apolloCookieNames,
    cloudflareCookieNames: lastCookieSummary.cloudflareCookieNames,
    hasCfBm: lastCookieSummary.hasCfBm,
    hasCfClearance: lastCookieSummary.hasCfClearance,
    hasActiveChallenge: lastChallengePresent,
    elapsedMs,
  };
}

export async function runApolloSessionPreflight(page: Page): Promise<ApolloSessionPreflight> {
  const pageState = await safePageEvaluate<{
    url: string;
    title: string;
    bodyText: string;
  }>(page, () => {
    const bodyText = (document.body?.innerText ?? '').toLowerCase();
    return {
      url: window.location.href,
      title: document.title ?? '',
      bodyText,
    };
  });
  const currentUrl = safePageUrl(page) ?? 'about:blank';
  const effectivePageState = pageState ?? {
    url: currentUrl,
    title: '',
    bodyText: '',
  };

  const sessionAuth = await extractSessionAuth(page);
  const cookies = await safePageCookies(page, effectivePageState.url.includes('apollo.io') ? effectivePageState.url : 'https://app.apollo.io/');
  const cookieSummary = summarizeApolloCookies(cookies);
  const challengeState = await safePageEvaluate<{
    hasTurnstile: boolean;
    hasCloudflare: boolean;
  }>(page, readManualChallengeStateScript);
  const blockers: string[] = [];
  const lowerUrl = effectivePageState.url.toLowerCase();
  const lowerTitle = effectivePageState.title.toLowerCase();
  const combinedText = `${lowerUrl}\n${lowerTitle}\n${effectivePageState.bodyText}`;

  if (!pageState) {
    blockers.push('Page closed before Apollo session preflight completed');
  }

  if (!isApolloAppUrl(effectivePageState.url)) {
    blockers.push(`Apollo app route not active: ${effectivePageState.url}`);
  }

  if (!isApolloPeopleUrl(effectivePageState.url)) {
    blockers.push(`Apollo people route not active: ${effectivePageState.url}`);
  }

  if (
    lowerUrl.includes('microsoft') ||
    lowerUrl.includes('login.live.com') ||
    lowerUrl.includes('microsoftonline.com')
  ) {
    blockers.push(`Microsoft interstitial still active: ${effectivePageState.url}`);
  }

  for (const pattern of SESSION_BLOCK_PATTERNS) {
    if (combinedText.includes(pattern)) {
      blockers.push(`Session page still shows auth/interstitial marker: ${pattern}`);
    }
  }

  if (!sessionAuth.csrfToken) {
    blockers.push('CSRF token missing from Apollo page');
  }

  if (cookieSummary.apolloCookieCount === 0) {
    blockers.push('No apollo.io cookies present in browser context');
  }

  if (challengeState?.hasTurnstile || challengeState?.hasCloudflare) {
    blockers.push('Cloudflare challenge still active on Apollo page');
  }

  return {
    pageUrl: effectivePageState.url,
    pageTitle: effectivePageState.title,
    csrfTokenPresent: Boolean(sessionAuth.csrfToken),
    apolloCookieCount: cookieSummary.apolloCookieCount,
    apolloCookieNames: cookieSummary.apolloCookieNames,
    cloudflareCookieNames: cookieSummary.cloudflareCookieNames,
    hasCfBm: cookieSummary.hasCfBm,
    hasCfClearance: cookieSummary.hasCfClearance,
    hasMicrosoftInterstitial: blockers.some(blocker => blocker.includes('Microsoft') || blocker.includes('auth/interstitial')),
    hasActiveChallenge: Boolean(challengeState?.hasTurnstile || challengeState?.hasCloudflare),
    blockers: [...new Set(blockers)],
  };
}
