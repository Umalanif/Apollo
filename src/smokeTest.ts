import { APOLLO_LOGIN_URL, configureApolloPage } from './apollo-browser';
import { attachPageDiagnostics } from './browser-diagnostics';
import { launchApolloContext } from './browser-launch';
import { getEnv } from './env/schema';
import { extractSessionAuth } from './extractor';
import { warmupApolloSession } from './session-preflight';
import { AuthManager } from './services/auth.service';

const OBSERVATION_MS = 30_000;

async function main(): Promise<void> {
  const env = getEnv();
  const context = await launchApolloContext(`smoke-${Date.now()}`);

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await configureApolloPage(page);
    attachPageDiagnostics(page, 'smoke');
    page.setDefaultNavigationTimeout(120_000);
    page.setDefaultTimeout(120_000);

    console.log(`[smoke] Using login entry ${APOLLO_LOGIN_URL}`);
    console.log(`[smoke] Using proxy http://${env.PROXY_HOST}:${env.PROXY_PORT}`);

    if (!(env.APOLLO_MS_EMAIL ?? env.APOLLO_EMAIL) || !(env.APOLLO_MS_PASSWORD ?? env.APOLLO_PASSWORD)) {
      console.error('[smoke] FATAL: APOLLO_MS_EMAIL and APOLLO_MS_PASSWORD must be set in .env');
      process.exitCode = 1;
      return;
    }

    console.log('[smoke] Starting Microsoft OAuth login flow');

    try {
      await AuthManager.ensureAuthenticated(page, 'smoke');
    } catch (err) {
      console.error('[smoke] FAILURE during Microsoft OAuth:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
      return;
    }

    await warmupApolloSession(page, 'smoke');
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
  } finally {
    await context.close();
  }
}

void main().catch(error => {
  console.error('[smoke] Fatal error:', error);
  process.exitCode = 1;
});
