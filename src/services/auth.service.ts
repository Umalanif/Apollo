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
import { solveRecaptcha } from '../captcha-solver';
import { AuthenticationError } from '../errors';

const AUTH_FILE_PATH = path.resolve('storage/auth.json');
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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
 * Detect if a CAPTCHA/Cloudflare challenge is present on the page.
 */
async function detectCaptchaChallenge(page: Page): Promise<{ type: string; sitekey?: string } | null> {
  // Check for Cloudflare Turnstile
  const turnstile = await page.$('[data-theme][class*="turnstile"]');
  if (turnstile) {
    return { type: 'turnstile' };
  }

  // Check for reCAPTCHA
  const recaptchaSitekey = await page.$eval(
    '[data-sitekey]',
    (el) => (el as HTMLElement).dataset.sitekey,
  ).catch(() => null);
  if (recaptchaSitekey) {
    return { type: 'recaptcha', sitekey: recaptchaSitekey };
  }

  // Check for generic CAPTCHA iframe
  const captchaFrame = await page.$('iframe[src*="captcha"]');
  if (captchaFrame) {
    return { type: 'captcha' };
  }

  return null;
}

/**
 * Perform the login flow on the Apollo login page.
 * Handles email/password filling, CAPTCHA solving, and form submission.
 */
async function performLogin(page: Page, jobId: string): Promise<void> {
  const { APOLLO_EMAIL, APOLLO_PASSWORD } = getEnv();

  logger.info({ jobId }, 'Proxy tunnel initialized with explicit credentials');

  // Wait for email input
  await page.waitForSelector('[name="email"]', { timeout: 10_000 });

  // Fill credentials
  await page.fill('[name="email"]', APOLLO_EMAIL);
  await page.fill('[name="password"]', APOLLO_PASSWORD);

  // Check for CAPTCHA before clicking login
  const challenge = await detectCaptchaChallenge(page);

  if (challenge) {
    logger.info({ jobId, challengeType: challenge.type }, 'CAPTCHA detected during login');

    if (challenge.type === 'recaptcha' && challenge.sitekey) {
      const token = await solveRecaptcha(challenge.sitekey, page.url());
      await page.evaluate((t: string) => {
        const ta = document.querySelector<HTMLTextAreaElement>('#g-recaptcha-response');
        if (ta) ta.value = t;
        document.dispatchEvent(new CustomEvent('recaptcha-token-ready', { detail: { token: t } }));
      }, token);
    } else if (challenge.type === 'turnstile') {
      // Turnstile auto-resolves in browser, just wait
      await page.waitForSelector('[data-theme][class*="turnstile"]', { state: 'hidden', timeout: 60_000 });
    }
  }

  // Click login button
  await page.click('button[type="submit"], button:has-text("Log In")');

  // Wait for navigation to dashboard
  try {
    await page.waitForFunction(
      () => !window.location.pathname.startsWith('/login'),
      { timeout: 30_000 },
    );
  } catch {
    // If still on login page, throw error
    const url = page.url();
    if (url.includes('/login')) {
      throw new AuthenticationError(`Login failed for ${APOLLO_EMAIL} — still on login page`);
    }
  }
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
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });

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
        await page.waitForLoadState('networkidle');

        // Verify we're on the dashboard
        const title = await page.title();
        if (title.toLowerCase().includes('log in')) {
          throw new AuthenticationError('Session did not persist — still seeing login page');
        }

        // Save the session state
        await page.context().storageState({ path: AUTH_FILE_PATH });

        logger.info({ jobId }, 'Session saved to storage/auth.json');
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
