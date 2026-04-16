import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { getMicrosoftCredentials } from '../env/schema';
import { AuthenticationError, ManualAuthenticationRequiredError } from '../errors';
import { logger } from '../logger';
import { runMicrosoftApolloLogin } from './microsoft-oauth';

const MANUAL_AUTH_TIMEOUT_MS = 180_000;
const MANUAL_AUTH_POLL_INTERVAL_MS = 1_000;

function isApolloAuthenticatedUrl(url: string): boolean {
  return /app\.apollo\.io/i.test(url) && !/\/#\/login\b/i.test(url);
}

async function screenshotOnError(jobId: string, step: string, page: Page): Promise<void> {
  const logsDir = path.resolve('logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const screenshotPath = path.join(logsDir, `debug-ms-flow-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  logger.error({ jobId, step, screenshotPath }, 'Microsoft SSO flow failed');
}

async function waitForManualAuthentication(page: Page, jobId: string, reason: string): Promise<void> {
  const deadline = Date.now() + MANUAL_AUTH_TIMEOUT_MS;

  logger.warn(
    { jobId, reason, timeoutMs: MANUAL_AUTH_TIMEOUT_MS, currentUrl: page.url() },
    'Manual authentication intervention required; waiting for Apollo session',
  );

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      throw new Error('Browser page was closed while waiting for manual authentication');
    }

    if (isApolloAuthenticatedUrl(page.url())) {
      logger.info({ jobId, currentUrl: page.url() }, 'Manual authentication completed');
      return;
    }

    await page.waitForTimeout(MANUAL_AUTH_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for manual authentication after: ${reason}`);
}

async function performLogin(page: Page, jobId: string): Promise<void> {
  const { email, password } = getMicrosoftCredentials();

  try {
    await runMicrosoftApolloLogin(page, {
      email,
      password,
      onStep: (step, message) => {
        logger.info({ jobId, step }, `[AUTH] ${message}`);
      },
      onRecoverableStepError: (step, err) => {
        logger.warn(
          { jobId, step, err: err instanceof Error ? err.message : String(err) },
          '[AUTH] Recoverable Microsoft auth step failed',
        );
      },
    });
  } catch (err) {
    if (err instanceof ManualAuthenticationRequiredError) {
      await waitForManualAuthentication(page, jobId, err.reason);
      return;
    }

    await screenshotOnError(jobId, 'microsoft-oauth', page);
    throw new AuthenticationError(
      err instanceof Error ? err.message : 'Microsoft SSO did not redirect back to Apollo',
    );
  }
}

export class AuthManager {
  static async ensureAuthenticated(page: Page, jobId: string): Promise<void> {
    if (isApolloAuthenticatedUrl(page.url())) {
      logger.info({ jobId, currentUrl: page.url() }, 'Apollo session already active, skipping login');
      return;
    }

    logger.info({ jobId }, 'Cold-start authentication enabled');
    await performLogin(page, jobId);
  }
}
