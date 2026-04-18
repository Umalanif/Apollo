import type { ConsoleMessage, Page } from 'playwright';
import { logger } from './logger';

export interface PageDiagnosticsSnapshot {
  turnstileRenderErrorCode: string | null;
  patChallengeFailed: boolean;
}

const pageDiagnostics = new WeakMap<Page, PageDiagnosticsSnapshot>();

function summarizeConsoleLocation(msg: ConsoleMessage): string | null {
  const location = msg.location();
  if (!location.url) {
    return null;
  }

  return `${location.url}:${location.lineNumber}:${location.columnNumber}`;
}

function getOrCreateDiagnostics(page: Page): PageDiagnosticsSnapshot {
  const existing = pageDiagnostics.get(page);
  if (existing) {
    return existing;
  }

  const diagnostics: PageDiagnosticsSnapshot = {
    turnstileRenderErrorCode: null,
    patChallengeFailed: false,
  };
  pageDiagnostics.set(page, diagnostics);
  return diagnostics;
}

function updateDiagnosticsFromText(page: Page, text: string): void {
  const diagnostics = getOrCreateDiagnostics(page);
  const turnstileCodeMatch = text.match(/turnstile.*error:\s*(\d{5,})/i);
  if (turnstileCodeMatch?.[1]) {
    diagnostics.turnstileRenderErrorCode = turnstileCodeMatch[1];
  }

  if (
    text.includes('Private Access Token challenge')
    || text.includes('the server responded with a status of 401')
  ) {
    diagnostics.patChallengeFailed = true;
  }
}

export function getPageDiagnosticsSnapshot(page: Page): PageDiagnosticsSnapshot {
  const diagnostics = pageDiagnostics.get(page);
  return diagnostics
    ? { ...diagnostics }
    : { turnstileRenderErrorCode: null, patChallengeFailed: false };
}

export function attachPageDiagnostics(page: Page, jobId: string): void {
  getOrCreateDiagnostics(page);

  page.on('popup', popup => {
    attachPageDiagnostics(popup, jobId);
  });

  page.on('console', msg => {
    updateDiagnosticsFromText(page, msg.text());
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
    updateDiagnosticsFromText(page, error.message);
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

  page.on('response', response => {
    if (response.url().includes('/cdn-cgi/challenge-platform/') && response.url().includes('/pat/') && response.status() === 401) {
      const diagnostics = getOrCreateDiagnostics(page);
      diagnostics.patChallengeFailed = true;
    }
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
