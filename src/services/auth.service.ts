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
 * Implements strict Auth Pipeline: no navigation to #/people until OAuth completes.
 *
 * Strict Execution Steps:
 * 1. Navigate to https://app.apollo.io/#/login (NOT #/people)
 * 2. Click "Log in with Microsoft" button
 * 3. Handle Microsoft OAuth (email → conditional password gateway → password → KMSI)
 * 4. Wait for redirect back to app.apollo.io/#/people
 * 5. Only then save storageState
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
      page.locator('button:has-text("Log in with Microsoft")').click(),
    ]);
    popup = capturedPopup;
    popup.setDefaultNavigationTimeout(OAUTH_TIMEOUT_MS);
    popup.setDefaultTimeout(OAUTH_TIMEOUT_MS);
    await popup.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    logger.info({ jobId, url: popup.url().substring(0, 80) }, '[AUTH] Step 1: Popup captured');

    // ── Ignore failed requests to non-critical tracking/CDN domains ──────────
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

  // ── Step 2: Microsoft OAuth - Email ─────────────────────────────────────────
  try {
    const emailInput = popup.locator('input[type="email"], input[name="loginfmt"], #i0116').first();
    await emailInput.waitFor({ timeout: 30_000 });
    await emailInput.fill(APOLLO_EMAIL);
    logger.info({ jobId }, '[AUTH] Step 2: Filled email');

    const nextButton = popup.locator('button[type="submit"], #idSIButton9, input[type="submit"]').first();
    await nextButton.click();
    logger.info({ jobId }, '[AUTH] Step 2: Clicked Next');

    // Allow Microsoft's JS animations and challenge routing to settle
    await popup.waitForTimeout(3000);
  } catch (err) {
    await screenshotOnError('Step 2: Enter email', popup);
    throw new AuthenticationError('Step 2 failed: Could not enter email on Microsoft IDP');
  }

  // ── Step 3: Conditional Branch - Password Gateway ───────────────────────────
  // Microsoft sometimes prompts for Authenticator app by default.
  // Check if "Use your password" link is visible before clicking.
  try {
    const usePasswordLink = popup.locator('text=Use your password').first();
    const isPasswordLinkVisible = await usePasswordLink.isVisible({ timeout: 5000 }).catch(() => false);

    if (isPasswordLinkVisible) {
      await usePasswordLink.click();
      logger.info({ jobId }, '[AUTH] Step 3: Clicked "Use your password" link');
      await popup.waitForTimeout(2000);
    } else {
      logger.info({ jobId }, '[AUTH] Step 3: Password link not visible — may be using password by default');
    }
  } catch (err) {
    // If the check fails, continue — the page may have already advanced
    logger.warn({ jobId }, '[AUTH] Step 3: Password gateway check failed — continuing');
  }

  // ── Step 4: Microsoft OAuth - Password ───────────────────────────────────────
  try {
    const passwordInput = popup.locator('input[type="password"], input[name="passwd"], #i0118').first();
    await passwordInput.waitFor({ timeout: 30_000 });
    await passwordInput.fill(APOLLO_PASSWORD);
    logger.info({ jobId }, '[AUTH] Step 4: Filled password');

    const signInButton = popup.locator('button[type="submit"], #idSIButton9, input[type="submit"]').first();
    await signInButton.click();
    logger.info({ jobId }, '[AUTH] Step 4: Clicked Sign In');

    await popup.waitForTimeout(3000);
  } catch (err) {
    await screenshotOnError('Step 4: Enter password', popup);
    throw new AuthenticationError('Step 4 failed: Could not enter password on Microsoft IDP');
  }

  // ── Step 5: Microsoft OAuth - KMSI (Keep Me Signed In) ─────────────────────
  try {
    const staySignedIn = popup.locator('#idSIButton9').first();
    await staySignedIn.waitFor({ timeout: 30_000 });
    await staySignedIn.click();
    logger.info({ jobId }, '[AUTH] Step 5: Confirmed "Stay signed in"');
  } catch (err) {
    // If the prompt doesn't appear, that's okay — continue
    logger.warn({ jobId }, '[AUTH] Step 5: "Stay signed in" prompt not detected — may have auto-advanced');
  }

  // ── Step 6: Wait for OAuth callback ─────────────────────────────────────────
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

  // ── Step 7: CRITICAL - Wait for #/people URL before saving session ──────────
  // Do NOT navigate to #/people or save storageState until this URL matches
  try {
    await page.waitForURL('**/app.apollo.io/#/people**', { timeout: OAUTH_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: OAUTH_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: OAUTH_TIMEOUT_MS });

    // Verify session cookies are present
    await page.waitForFunction(
      () => document.cookie.includes('_apollo') || document.cookie.includes('XSRF-TOKEN'),
      { timeout: OAUTH_TIMEOUT_MS },
    );

    logger.info({ jobId, url: page.url() }, '[AUTH] Step 7: Confirmed redirect to #/people — session valid');
  } catch (err) {
    await screenshotOnError('Step 7: Verify #/people redirect', page);
    throw new AuthenticationError('Step 7 failed: Did not redirect to #/people after SSO — session NOT saved');
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

    const LOGIN_URL = 'https://app.apollo.io/#/login';
    const MAX_LOGIN_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
      try {
        // Navigate directly to login page — do NOT navigate to #/people
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: OAUTH_TIMEOUT_MS });
        await page.waitForTimeout(2000); // Allow React to initialize

        const currentUrl = page.url();
        logger.info({ jobId, attempt, url: currentUrl }, 'On login page');

        // Perform the Microsoft SSO flow — this handles all OAuth steps
        // and waits for #/people URL before returning
        await performLogin(page, jobId);

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
