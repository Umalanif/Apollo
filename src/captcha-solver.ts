/**
 * CAPTCHA Solver — 2captcha-ts wrapper for reCAPTCHA solving
 *
 * Phase 7.4: Takes a sitekey + page URL, submits to 2captcha,
 * polls until token is ready, returns the token string.
 *
 * Retry: 2captcha returns ERROR_CODES on submit/pool that are retryable.
 * We wrap the raw solver with a retry loop (up to 3 attempts per solve).
 *
 * Non-retryable failures (invalid sitekey, domain mismatch, out of credits)
 * are thrown as regular errors — the worker retry loop (Phase 7.5/7.6)
 * will catch and rotate proxy.
 *
 * Usage:
 *   const token = await solveRecaptcha(sitekey, pageUrl);
 *   // inject token via page.evaluate(() => callback(token));
 */

import { getEnv } from './env/schema';
import { logger } from './logger';
import { Solver } from '2captcha-ts';

// ── 2captcha retryable error codes ───────────────────────────────────────────

const RETRYABLE_CODES = new Set([
  'ERROR_KEY_DOES_NOT_EXIST',
  'ERROR_ZERO_CAPTCHA_FILESIZE',
  'ERROR_TOO_SMALL_CAPTCHA_FILESIZE',
  'ERROR_WRONG_CAPTCHA_FILE',
  'ERROR_CAPTCHA_UNSOLVABLE',
  'ERROR_WRONG_USER_KEY',
  'ERROR_WRONG_ID_FORMAT',
  'ERROR_BAD_TOKEN_OR_PAGEURL',
  'ERROR_IP_NOT_ALLOWED',
  'ERROR_TOKEN_EXPIRED',
  'ERROR_IP_ADDR',
  'ERROR_DOMAIN_NOT_ALLOWED',
  'ERROR_2CAPTCHA_BLOCKED',
  'ERROR_TOO_MUCH_REQUESTS',
]);

function isRetryable(code: string): boolean {
  return RETRYABLE_CODES.has(code);
}

// ── Solver instance (lazy singleton) ─────────────────────────────────────────

let solverInstance: Solver | null = null;

function getSolver(): Solver {
  if (solverInstance) return solverInstance;

  const { TWO_CAPTCHA_API_KEY } = getEnv();

  solverInstance = new Solver(TWO_CAPTCHA_API_KEY);
  logger.debug('2captcha-ts Solver initialized');

  return solverInstance;
}

// ── reCAPTCHA solve function ───────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;
const SUBMIT_DELAY_MS = 5_000; // wait between retry attempts

export interface SolveRecaptchaOptions {
  /** Extra 2captcha options (e.g. { proxy: { type: 'http', uri: '...' } }) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraOptions?: Record<string, any>;
}

/**
 * Solve a Google reCAPTCHA given its sitekey and the page URL it appears on.
 *
 * @param sitekey   - The data-sitekey value from the reCAPTCHA element
 * @param pageUrl   - The full URL of the page containing the challenge
 * @param opts      - Optional extra 2captcha parameters (proxy, invisible, etc.)
 * @returns         - The solved CAPTCHA token string
 * @throws          - Error on non-retryable failure or after MAX_ATTEMPTS
 */
export async function solveRecaptcha(
  sitekey: string,
  pageUrl: string,
  opts: SolveRecaptchaOptions = {},
): Promise<string> {
  const solver = getSolver();

  logger.info({ sitekey: sitekey.slice(0, 10) + '…', pageUrl }, 'Submitting reCAPTCHA to 2captcha');

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await solver.recaptcha({
        googlekey: sitekey,
        pageurl: pageUrl,
        ...opts.extraOptions,
      });

      logger.info(
        { tokenPreview: result.data.slice(0, 20) + '…', provider: '2captcha' },
        'reCAPTCHA solved successfully',
      );

      return result.data;
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      lastError = err instanceof Error ? err : new Error(code);

      const retryable = isRetryable(code);
      logger.warn(
        { attempt, maxAttempts: MAX_ATTEMPTS, code, retryable },
        `2captcha solve attempt ${attempt} failed`,
      );

      if (!retryable) {
        // Non-retryable: bubble up immediately
        throw lastError;
      }

      if (attempt < MAX_ATTEMPTS) {
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, SUBMIT_DELAY_MS));
      }
    }
  }

  // All attempts exhausted
  throw lastError ?? new Error('reCAPTCHA solve failed after max attempts');
}
