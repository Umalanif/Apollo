import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { getMicrosoftCredentials } from '../env/schema';
import { AuthenticationError } from '../errors';
import { logger } from '../logger';
import { runMicrosoftApolloLogin } from './microsoft-oauth';

async function screenshotOnError(jobId: string, step: string, page: Page): Promise<void> {
  const logsDir = path.resolve('logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const screenshotPath = path.join(logsDir, `debug-ms-flow-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  logger.error({ jobId, step, screenshotPath }, 'Microsoft SSO flow failed');
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
    await screenshotOnError(jobId, 'microsoft-oauth', page);
    throw new AuthenticationError(
      err instanceof Error ? err.message : 'Microsoft SSO did not redirect back to Apollo',
    );
  }
}

export class AuthManager {
  static async ensureAuthenticated(page: Page, jobId: string): Promise<void> {
    logger.info({ jobId }, 'Cold-start authentication enabled');
    await performLogin(page, jobId);
  }
}
