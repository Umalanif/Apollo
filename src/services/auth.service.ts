/**
 * Authentication service — handles Apollo login and session persistence
 *
 * Phase 16.2: Auto-login flow using APOLLO_EMAIL/APOLLO_PASSWORD from env.
 * Session state is persisted to storage/auth.json and reused for up to 24 hours.
 */

import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { getEnv } from '../env/schema';
import { logger } from '../logger';
import { AuthenticationError } from '../errors';

const AUTH_FILE_PATH = path.resolve('storage/auth.json');
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const OAUTH_TIMEOUT_MS = 120_000;

/**
 * Check if the existing auth file is valid (exists and not expired).
 */
function isAuthStateValid(): boolean {
  if (!fs.existsSync(AUTH_FILE_PATH)) {
    return false;
  }
  try {
    const stat = fs.statSync(AUTH_FILE_PATH);
    const age = Date.now() - stat.mtimeMs;
    return age < SESSION_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Perform the login flow on the Apollo login page using Microsoft SSO.
 * Handles the full Microsoft OAuth flow and returns to Apollo.
 *
 * Phase 17.4: Microsoft login opens a popup window — we capture it via
 * waitForEvent('popup') and perform all steps inside the popup object.
 */
async function performLogin(page: Page, jobId: string): Promise<void> {
  const { APOLLO_EMAIL, APOLLO_PASSWORD } = getEnv();

  if (!APOLLO_EMAIL || !APOLLO_PASSWORD) {
    throw new AuthenticationError('APOLLO_EMAIL / APOLLO_PASSWORD not set in .env');
  }

  const screenshotOnError = async (step: string, target: Page | import('playwright').Page) => {
    const logsDir = path.resolve('logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const screenshotPath = `logs/debug-ms-flow-${Date.now()}.png`;
    await target.screenshot({ path: screenshotPath, fullPage: true });
    logger.error({ jobId, step, screenshotPath }, `Microsoft SSO flow failed at step: ${step}`);
  };

  logger.info({ jobId }, '[AUTH] Starting Microsoft SSO login flow');
  page.setDefaultNavigationTimeout(OAUTH_TIMEOUT_MS);
  page.setDefaultTimeout(OAUTH_TIMEOUT_MS);

  // ── Step 1: Capture the OAuth popup ─────────────────────────────────────────
  let popup: import('playwright').Page;
  try {
    const [capturedPopup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15_000 }),
      page.locator('button').filter({ hasText: /Microsoft/i }).first().click(),
    ]);
    popup = capturedPopup;
    popup.setDefaultNavigationTimeout(OAUTH_TIMEOUT_MS);
    popup.setDefaultTimeout(OAUTH_TIMEOUT_MS);
    await popup.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    logger.info({ jobId, url: popup.url().substring(0, 80) }, '[AUTH] Step 1: Popup captured');

    // ── Ignore failed requests to non-critical tracking/CDN domains ──────────
    // This saves proxy bandwidth for the Microsoft CDN and prevents noise in logs
    const NON_CRITICAL_DOMAINS = new Set([
      'sentry.io',
      'google-analytics.com',
      'googletagmanager.com',
      'analytics.google.com',
      'segment.io',
      'mixpanel.com',
      'hotjar.com',
      'intercom.io',
      'mouseflow.com',
      'fullstory.com',
    ]);
    popup.on('requestfailed', (req) => {
      try {
        const hostname = new URL(req.url()).hostname;
        if (NON_CRITICAL_DOMAINS.has(hostname)) {
          return; // silently ignore
        }
      } catch {
        // ignore
      }
    });
  } catch (err) {
    await screenshotOnError('Step 1: Capture popup', page);
    throw new AuthenticationError('Step 1 failed: Could not open Microsoft SSO popup');
  }

  // ── Step 2: Enter Email inside the popup ────────────────────────────────────
  try {
    const emailInput = popup.locator('input[type="email"], input[name="loginfmt"]').first();
    await emailInput.waitFor({ timeout: 30_000 });
    await emailInput.fill(APOLLO_EMAIL);
    logger.info({ jobId }, '[AUTH] Step 2: Filled email in popup');

    const nextButton = popup.locator('input[type="submit"], #idSIButton9').first();
    await nextButton.click();
    logger.info({ jobId }, '[AUTH] Step 2: Clicked Next');

    // Allow Microsoft's JS animations and challenge routing to settle
    await popup.waitForTimeout(3000);
  } catch (err) {
    await screenshotOnError('Step 2: Enter email', popup);
    throw new AuthenticationError('Step 2 failed: Could not enter email on Microsoft IDP');
  }

  // ── Step 3: Bypass email code — click "Use your password instead" ───────────
  try {
    const switchToPassword = popup.locator('#idA_PWD_SwitchToPassword').first();
    await switchToPassword.waitFor({ timeout: 30_000 });
    await switchToPassword.click();
    logger.info({ jobId }, '[AUTH] Step 3: Switched to password option');

    await popup.waitForTimeout(2000);
  } catch (err) {
    await screenshotOnError('Step 3: Switch to password', popup);
    throw new AuthenticationError('Step 3 failed: Could not switch to password option');
  }

  // ── Step 4: Enter Password inside the popup ─────────────────────────────────
  try {
    const passwordInput = popup.locator('input[type="password"], input[name="passwd"]').first();
    await passwordInput.waitFor({ timeout: 30_000 });
    await passwordInput.fill(APOLLO_PASSWORD);
    logger.info({ jobId }, '[AUTH] Step 4: Filled password in popup');

    const signInButton = popup.locator('input[type="submit"], #idSIButton9').first();
    await signInButton.click();
    logger.info({ jobId }, '[AUTH] Step 4: Clicked Sign In');

    await popup.waitForTimeout(3000);
  } catch (err) {
    await screenshotOnError('Step 4: Enter password', popup);
    throw new AuthenticationError('Step 4 failed: Could not enter password on Microsoft IDP');
  }

  // ── Step 5: Handle "Stay Signed In?" prompt — click "Yes" ───────────────────
  try {
    const staySignedIn = popup.locator('#idSIButton9').first();
    await staySignedIn.waitFor({ timeout: 30_000 });
    await staySignedIn.click();
    logger.info({ jobId }, '[AUTH] Step 5: Confirmed "Stay signed in" in popup');
  } catch (err) {
    // If the prompt doesn't appear, that's okay — continue
    logger.warn({ jobId }, '[AUTH] Step 5: "Stay signed in" prompt not detected — may have auto-advanced');
  }

  // ── Step 6: Wait for popup to close ─────────────────────────────────────────
  try {
    await Promise.race([
      popup.waitForEvent('close', { timeout: OAUTH_TIMEOUT_MS }),
      popup.waitForURL(/apollo\.io\/api\/v1\/email_accounts\/ms_auth_callback/i, { timeout: OAUTH_TIMEOUT_MS }),
    ]);
    logger.info({ jobId }, '[AUTH] Step 6: OAuth redirect chain reached Apollo callback');
  } catch (err) {
    await screenshotOnError('Step 6: Popup close', popup);
    throw new AuthenticationError('Step 6 failed: OAuth redirect chain did not reach Apollo callback');
  }

  // ── Step 7: Verify main page session — wait for redirect back to #/people ────
  try {
    await Promise.any([
      page.waitForURL(/apollo\.io\/api\/v1\/email_accounts\/ms_auth_callback/i, { timeout: OAUTH_TIMEOUT_MS }),
      page.waitForURL(/app\.apollo\.io\/(#\/people|#\/home|\/?$)/i, { timeout: OAUTH_TIMEOUT_MS }),
      page.waitForFunction(
        () => window.location.href.includes('app.apollo.io/#/people'),
        { timeout: OAUTH_TIMEOUT_MS },
      ),
    ]);

    await page.waitForLoadState('domcontentloaded', { timeout: OAUTH_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: OAUTH_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForFunction(
      () => document.cookie.includes('_apollo') || document.cookie.includes('XSRF-TOKEN') || window.location.hostname.endsWith('apollo.io'),
      { timeout: OAUTH_TIMEOUT_MS },
    );
    logger.info({ jobId, url: page.url() }, '[AUTH] Step 7: Redirected back to Apollo with session cookies');
  } catch (err) {
    await screenshotOnError('Step 7: Verify Apollo redirect', page);
    throw new AuthenticationError('Step 7 failed: Did not redirect back to Apollo after SSO');
  }

  logger.info({ jobId }, '[AUTH] Microsoft SSO flow completed successfully');
}

/**
 * AuthManager — ensures valid Apollo session via cookie persistence.
 *
 * Usage:
 *   await AuthManager.ensureAuthenticated(page);
 */
export class AuthManager {
  /**
   * Ensure the page has a valid Apollo session.
   * - If storage/auth.json exists and is < 24h old, reuse it (fast path).
   * - Otherwise, navigate to app.apollo.io and perform login if needed.
   *
   * @throws AuthenticationError if login fails after 3 attempts
   */
  static async ensureAuthenticated(page: Page, jobId: string): Promise<void> {
    // Check if we have a valid existing session
    if (isAuthStateValid()) {
      logger.debug({ jobId }, 'Existing session is valid — using storage/auth.json');
      return;
    }

    logger.info({ jobId }, 'No valid session — performing login flow');

    const HOME_URL = 'https://app.apollo.io/';
    const MAX_LOGIN_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
      try {
        // Navigate to Apollo home
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: OAUTH_TIMEOUT_MS });

        // Wait for React app to initialize
        await page.waitForTimeout(2000);

        const currentUrl = page.url();

        // Check if redirected to login
        if (currentUrl.includes('/login')) {
          logger.info({ jobId, attempt }, 'Redirected to login page — performing login');
          await performLogin(page, jobId);
        } else {
          // Already authenticated — session cookies were set by proxy or previous login
          logger.info({ jobId }, 'Already authenticated — session is valid');
        }

        // Wait for network to be idle (session cookies fully settled)
        await page.waitForLoadState('networkidle', { timeout: OAUTH_TIMEOUT_MS });

        // Verify we're on the dashboard
        const title = await page.title();
        if (title.toLowerCase().includes('log in')) {
          throw new AuthenticationError('Session did not persist — still seeing login page');
        }

        // CRITICAL: Do NOT attempt to navigate to #/people until the page title is "Apollo" (Dashboard)
        // Wait for Apollo dashboard title
        const DASHBOARD_TITLE_FRAGMENT = 'apollo';
        if (!title.toLowerCase().includes(DASHBOARD_TITLE_FRAGMENT)) {
          logger.info({ jobId, title }, 'Waiting for Apollo dashboard title...');
          try {
            await page.waitForFunction(
              () => document.title.toLowerCase().includes('apollo'),
              { timeout: OAUTH_TIMEOUT_MS },
            );
          } catch {
            throw new AuthenticationError(`Dashboard title never appeared — got: "${title}"`);
          }
        }

        logger.info({ jobId, title }, 'Session saved to storage/browser_profile');
        return;

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ jobId, attempt, err: msg }, `Login attempt ${attempt} failed`);

        if (err instanceof AuthenticationError) {
          throw err; // Don't retry authentication errors
        }

        if (attempt === MAX_LOGIN_ATTEMPTS) {
          throw new AuthenticationError(`FATAL: AUTH_FAILED after ${MAX_LOGIN_ATTEMPTS} attempts — ${msg}`);
        }

        // Wait before retry
        await page.waitForTimeout(2000);
      }
    }
  }
}
