import { chromium, type ConsoleMessage, type Page } from 'playwright';

import { APOLLO_LOGIN_URL, APOLLO_PROXY_BYPASS_LIST, configureApolloPage } from './apollo-browser';
import { extractSessionAuth } from './extractor';
import { runMicrosoftApolloLogin } from './services/microsoft-oauth';

const OBSERVATION_MS = 30_000;

function logConsoleMessage(msg: ConsoleMessage): void {
  const location = msg.location();
  const suffix = location.url ? ` (${location.url}:${location.lineNumber}:${location.columnNumber})` : '';
  console.log(`[console:${msg.type()}] ${msg.text()}${suffix}`);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 500,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      `--proxy-bypass-list=${APOLLO_PROXY_BYPASS_LIST}`,
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });

  const page = await context.newPage();
  await configureApolloPage(page);
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(120_000);

  page.on('console', logConsoleMessage);
  page.on('pageerror', error => {
    console.error(`[pageerror] ${error.name}: ${error.message}`);
  });
  page.on('requestfailed', request => {
    const failure = request.failure();
    console.error(`[requestfailed] ${request.url()} -> ${failure?.errorText ?? 'unknown'}`);
  });
  page.on('popup', popup => {
    attachPopupLogging(popup);
  });

  console.log(`[smoke] Using login entry ${APOLLO_LOGIN_URL}`);

  const email = process.env.APOLLO_MS_EMAIL;
  const password = process.env.APOLLO_MS_PASSWORD;

  if (!email || !password) {
    console.error('[smoke] FATAL: APOLLO_MS_EMAIL and APOLLO_MS_PASSWORD must be set in .env');
    process.exitCode = 1;
    await browser.close();
    return;
  }

  console.log('[smoke] Starting Microsoft OAuth login flow');

  try {
    await runMicrosoftApolloLogin(page, {
      email,
      password,
      onStep: (_step, message) => {
        console.log(`[smoke] ${message}`);
      },
      onRecoverableStepError: (_step, err) => {
        console.warn('[smoke] Recoverable auth step issue:', err instanceof Error ? err.message : err);
      },
    });
  } catch (err) {
    console.error('[smoke] FAILURE during Microsoft OAuth:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
    await browser.close();
    return;
  }

  await page.waitForLoadState('networkidle').catch(() => {
    console.log('[smoke] networkidle wait timed out; continuing with current page state');
  });

  let authResult: Awaited<ReturnType<typeof extractSessionAuth>> | null = null;
  try {
    authResult = await extractSessionAuth(page);
  } catch (err) {
    console.error('[smoke] extractSessionAuth() threw:', err instanceof Error ? err.message : err);
  }

  const allCookies = await context.cookies();
  const apolloCookies = allCookies.filter(cookie => cookie.domain.includes('apollo.io'));

  console.log('[smoke] Auth extraction results:');
  console.log(`  Apollo cookie count: ${apolloCookies.length}`);
  console.log(`  CSRF token found: ${authResult?.csrfToken ? 'true' : 'false'}`);

  if (apolloCookies.length > 0) {
    console.log('[smoke] RESULT: SUCCESS - apollo.io cookies found after login');
  } else {
    console.error('[smoke] RESULT: FAILURE - no apollo.io cookies found after login');
    process.exitCode = 1;
  }

  console.log(`[smoke] Waiting ${OBSERVATION_MS / 1000}s for observation`);
  await page.waitForTimeout(OBSERVATION_MS);
  await browser.close();
}

function attachPopupLogging(popup: Page): void {
  popup.on('console', logConsoleMessage);
  popup.on('pageerror', error => {
    console.error(`[popup:pageerror] ${error.name}: ${error.message}`);
  });
  popup.on('requestfailed', request => {
    const failure = request.failure();
    console.error(`[popup:requestfailed] ${request.url()} -> ${failure?.errorText ?? 'unknown'}`);
  });
}

main().catch(error => {
  console.error('[smoke] Fatal error:', error);
  process.exitCode = 1;
});
