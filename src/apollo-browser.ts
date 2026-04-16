import type { Page } from 'playwright';
import { installAutomationMaskScript, installTurnstileObserverScript } from './browser-context';
import { getEnv } from './env/schema';

function normalizeApolloLocale(locale: string | undefined): string {
  const trimmed = (locale ?? '').trim();
  if (!trimmed) {
    return 'en';
  }

  return trimmed.split(/[-_]/)[0]?.toLowerCase() || 'en';
}

export function getApolloLoginUrl(locale = getEnv().BROWSER_LOCALE): string {
  const apolloLocale = normalizeApolloLocale(locale);
  return `https://app.apollo.io/#/login?locale=${encodeURIComponent(apolloLocale)}`;
}

export const APOLLO_LOGIN_URL = getApolloLoginUrl();

export const APOLLO_PROXY_BYPASS_LIST = [
  '*.microsoftonline.com',
  '*.msauth.net',
  '*.msftauth.net',
  '*.msauthimages.net',
  '*.aadcdn.msftauth.net',
  '*.live.com',
  '*.microsoft.com',
  '*.aadcdn.microsoftonline-p.com',
].join(',');

const BLOCKED_TYPES = new Set([
  'media',
]);

const MICROSOFT_AUTH_HOST_PATTERNS = [
  'microsoftonline.com',
  'microsoft.com',
  'msauth.net',
  'msftauth.net',
  'msauthimages.net',
  'aadcdn.msftauth.net',
  'aadcdn.microsoftonline-p.com',
  'live.com',
];

const TRUSTED_HOST_PATTERNS = [
  'apollo.io',
  'cloudflare.com',
  'challenges.cloudflare.com',
  'google.com',
  'gstatic.com',
  'recaptcha.net',
  'hcaptcha.com',
  ...MICROSOFT_AUTH_HOST_PATTERNS,
];

export function isMicrosoftAuthUrl(url: string): boolean {
  return MICROSOFT_AUTH_HOST_PATTERNS.some(pattern => url.includes(pattern));
}

function matchesHostPattern(hostname: string, pattern: string): boolean {
  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

function isTrustedHost(hostname: string): boolean {
  return TRUSTED_HOST_PATTERNS.some(pattern => matchesHostPattern(hostname, pattern));
}

export async function configureApolloPage(page: Page): Promise<void> {
  await page.addInitScript(installAutomationMaskScript);
  await page.addInitScript(installTurnstileObserverScript);

  await page.route('**/*', async route => {
    const request = route.request();
    const url = request.url();
    const type = request.resourceType();
    const parsedUrl = new URL(url);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      await route.abort();
      return;
    }

    if (!isTrustedHost(parsedUrl.hostname) && BLOCKED_TYPES.has(type)) {
      await route.abort();
      return;
    }

    await route.continue();
  });
}
