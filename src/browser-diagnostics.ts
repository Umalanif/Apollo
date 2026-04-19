import type { ConsoleMessage, Page } from 'playwright';
import { logger } from './logger';
import { safePageUrl } from './playwright-helpers';

export interface PageDiagnosticsSnapshot {
  turnstileRenderErrorCode: string | null;
  patChallengeFailed: boolean;
  turnstileWidgetState: {
    sitekey: string | null;
    action: string | null;
    cData: string | null;
    chlPageData: string | null;
  };
}

const pageDiagnostics = new WeakMap<Page, PageDiagnosticsSnapshot>();
const attachedPages = new WeakSet<Page>();
const lastKnownPageUrls = new WeakMap<Page, string | null>();

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
    turnstileWidgetState: {
      sitekey: null,
      action: null,
      cData: null,
      chlPageData: null,
    },
  };
  pageDiagnostics.set(page, diagnostics);
  return diagnostics;
}

function updateDiagnosticsFromText(page: Page, text: string): void {
  const diagnostics = getOrCreateDiagnostics(page);
  const normalized = text.toLowerCase();

  if (normalized.includes('pat') && normalized.includes('401')) {
    diagnostics.patChallengeFailed = true;
  }

  const renderErrorMatch = text.match(/turnstile(?:[\w\s:-]+)?error(?:[\w\s:-]+)?([a-z0-9_-]{2,})/i);
  if (renderErrorMatch?.[1]) {
    diagnostics.turnstileRenderErrorCode = renderErrorMatch[1];
  }
}

export function getPageDiagnosticsSnapshot(page: Page): PageDiagnosticsSnapshot {
  const diagnostics = pageDiagnostics.get(page);
  return diagnostics
    ? { ...diagnostics }
    : {
      turnstileRenderErrorCode: null,
      patChallengeFailed: false,
      turnstileWidgetState: {
        sitekey: null,
        action: null,
        cData: null,
        chlPageData: null,
      },
    };
}

export function attachPageDiagnostics(page: Page, jobId: string): void {
  if (attachedPages.has(page)) {
    return;
  }

  attachedPages.add(page);
  getOrCreateDiagnostics(page);
  lastKnownPageUrls.set(page, safePageUrl(page));

  page.on('popup', popup => {
    attachPageDiagnostics(popup, jobId);
  });

  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      lastKnownPageUrls.set(page, frame.url());
    }
  });

  page.on('close', () => {
    logger.warn(
      {
        jobId,
        finalUrl: lastKnownPageUrls.get(page) ?? null,
      },
      'Browser page closed',
    );
  });

  page.on('crash', () => {
    logger.error(
      {
        jobId,
        finalUrl: lastKnownPageUrls.get(page) ?? null,
      },
      'Browser page crashed',
    );
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
    void response;
  });

  page.on('request', request => {
    void request;
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
