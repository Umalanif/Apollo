import type { ConsoleMessage, Page } from 'playwright';
import { logger } from './logger';

function summarizeConsoleLocation(msg: ConsoleMessage): string | null {
  const location = msg.location();
  if (!location.url) {
    return null;
  }

  return `${location.url}:${location.lineNumber}:${location.columnNumber}`;
}

export function attachPageDiagnostics(page: Page, jobId: string): void {
  page.on('popup', popup => {
    attachPageDiagnostics(popup, jobId);
  });

  page.on('console', msg => {
    logger.info(
      {
        jobId,
        consoleType: msg.type(),
        text: msg.text(),
        location: summarizeConsoleLocation(msg),
      },
      'Browser console message',
    );
  });

  page.on('pageerror', error => {
    logger.error(
      {
        jobId,
        errorName: error.name,
        message: error.message,
        stack: error.stack,
      },
      'Browser page error',
    );
  });

  page.on('requestfailed', request => {
    logger.warn(
      {
        jobId,
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        failure: request.failure()?.errorText ?? 'unknown',
      },
      'Browser request failed',
    );
  });
}
