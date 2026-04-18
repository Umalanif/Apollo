import type { Page } from 'playwright';

function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  return String(err);
}

export function isTargetClosedError(err: unknown): boolean {
  const message = normalizeErrorMessage(err).toLowerCase();
  return (
    message.includes('target closed')
    || message.includes('page closed')
    || message.includes('context closed')
    || message.includes('browser has been closed')
  );
}

export async function safePageEvaluate<T>(
  page: Page,
  pageFunction: any,
  arg?: unknown,
): Promise<T | null> {
  if (page.isClosed()) {
    return null;
  }

  try {
    return await page.evaluate(pageFunction as never, arg as never) as T;
  } catch (err) {
    if (isTargetClosedError(err)) {
      return null;
    }

    throw err;
  }
}

export async function safePageScreenshot(
  page: Page,
  options: Parameters<Page['screenshot']>[0],
): Promise<Buffer | null> {
  if (page.isClosed()) {
    return null;
  }

  try {
    return await page.screenshot(options);
  } catch (err) {
    if (isTargetClosedError(err)) {
      return null;
    }

    throw err;
  }
}

export async function safePageWaitForTimeout(page: Page, timeoutMs: number): Promise<boolean> {
  if (page.isClosed()) {
    return false;
  }

  try {
    await page.waitForTimeout(timeoutMs);
    return true;
  } catch (err) {
    if (isTargetClosedError(err)) {
      return false;
    }

    throw err;
  }
}

export function safePageUrl(page: Page): string | null {
  if (page.isClosed()) {
    return null;
  }

  try {
    return page.url();
  } catch (err) {
    if (isTargetClosedError(err)) {
      return null;
    }

    throw err;
  }
}
