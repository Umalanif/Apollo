import type { Page } from 'playwright';

import { APOLLO_LOGIN_URL } from '../apollo-browser';

const OAUTH_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const TRANSITION_DELAY_MS = 3_000;

const selectors = {
  microsoftButton: 'button[data-cta-variant="secondary"]:has-text("Log In with Microsoft")',
  emailInput: '#i0116, input[type="email"], input[name="loginfmt"]',
  passwordInput: '#i0118, input[type="password"], input[name="passwd"]',
  submitButton: '#idSIButton9, button[type="submit"], input[type="submit"]',
  usePasswordLink: 'span[role="button"]:has-text("Use your password")',
  staySignedInButton: 'button[data-testid="primaryButton"]:has-text("Yes")',
};

type FlowStep =
  | 'open-login'
  | 'microsoft-button'
  | 'email'
  | 'use-password'
  | 'password'
  | 'kmsi'
  | 'apollo-redirect';

interface Hooks {
  onStep?: (step: FlowStep, message: string) => void | Promise<void>;
  onRecoverableStepError?: (step: FlowStep, error: unknown) => void | Promise<void>;
}

export interface MicrosoftLoginOptions extends Hooks {
  email: string;
  password: string;
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function waitForAnyVisible(page: Page, selectorList: string[], timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectorList) {
      if (await isVisible(page, selector)) {
        return selector;
      }
    }

    if (/app\.apollo\.io(?!.*\/login)/i.test(page.url())) {
      return 'apollo-redirect';
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for one of: ${selectorList.join(', ')}`);
}

async function clickSubmit(page: Page): Promise<void> {
  await page.locator(selectors.submitButton).first().click();
}

async function fillField(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector).first();
  await input.waitFor({ timeout: STEP_TIMEOUT_MS });
  await input.scrollIntoViewIfNeeded().catch(() => undefined);
  await input.click({ timeout: STEP_TIMEOUT_MS, force: true });

  const editable = await input.isEditable().catch(() => false);
  if (!editable) {
    throw new Error(`Field is not editable for selector: ${selector}`);
  }

  await input.focus();
  await input.press('Control+A').catch(() => undefined);
  await input.press('Delete').catch(() => undefined);
  await input.pressSequentially(value, { delay: 50 });

  let currentValue = await input.inputValue().catch(() => '');
  if (currentValue === value) {
    return;
  }

  await page.keyboard.insertText(value).catch(() => undefined);
  currentValue = await input.inputValue().catch(() => '');
  if (currentValue === value) {
    return;
  }

  await input.evaluate((element, nextValue) => {
    const inputElement = element as HTMLInputElement;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(inputElement, nextValue);
    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    inputElement.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);

  currentValue = await input.inputValue().catch(() => '');
  if (currentValue !== value) {
    throw new Error(`Field value did not persist for selector: ${selector}`);
  }
}

async function submitEmail(page: Page, email: string, hooks: Hooks): Promise<void> {
  await fillField(page, selectors.emailInput, email);
  await clickSubmit(page);
  await hooks.onStep?.('email', 'Submitted Microsoft email');
}

async function reachPasswordInput(page: Page, email: string, hooks: Hooks): Promise<void> {
  const handledStates = new Set<string>();

  for (let attempt = 0; attempt < 5; attempt++) {
    const nextState = await waitForAnyVisible(
      page,
      [selectors.emailInput, selectors.usePasswordLink, selectors.passwordInput],
      STEP_TIMEOUT_MS,
    );

    if (nextState === 'apollo-redirect') {
      return;
    }

    if (nextState === selectors.passwordInput) {
      return;
    }

    if (nextState === selectors.usePasswordLink) {
      await page.locator(selectors.usePasswordLink).first().click();
      await hooks.onStep?.('use-password', 'Clicked "Use your password"');
      await page.waitForTimeout(TRANSITION_DELAY_MS);
      continue;
    }

    if (nextState === selectors.emailInput) {
      const emailInput = page.locator(selectors.emailInput).first();
      const currentValue = (await emailInput.inputValue().catch(() => '')).trim().toLowerCase();
      if (!handledStates.has(nextState) || currentValue !== email.trim().toLowerCase()) {
        handledStates.add(nextState);
        await submitEmail(page, email, hooks);
        await page.waitForTimeout(TRANSITION_DELAY_MS);
        continue;
      }
    }
  }

  throw new Error('Microsoft password input did not appear');
}

async function submitPassword(page: Page, password: string, hooks: Hooks): Promise<void> {
  await fillField(page, selectors.passwordInput, password);
  await clickSubmit(page);
  await hooks.onStep?.('password', 'Submitted Microsoft password');
}

async function handleStaySignedIn(page: Page, hooks: Hooks): Promise<void> {
  await page.waitForTimeout(TRANSITION_DELAY_MS);

  const staySignedInVisible = await isVisible(page, selectors.staySignedInButton);
  if (!staySignedInVisible) {
    await hooks.onStep?.('kmsi', 'KMSI prompt not visible');
    return;
  }

  try {
    await page.locator(selectors.staySignedInButton).first().click();
    await hooks.onStep?.('kmsi', 'Accepted KMSI');
  } catch (error) {
    await hooks.onRecoverableStepError?.('kmsi', error);
  }
}

export async function runMicrosoftApolloLogin(page: Page, options: MicrosoftLoginOptions): Promise<void> {
  const { email, password, onStep, onRecoverableStepError } = options;

  page.setDefaultNavigationTimeout(OAUTH_TIMEOUT_MS);
  page.setDefaultTimeout(OAUTH_TIMEOUT_MS);

  await page.goto(APOLLO_LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: OAUTH_TIMEOUT_MS,
  });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await onStep?.('open-login', 'Opened Apollo login page');

  await page.locator(selectors.microsoftButton).first().waitFor({ timeout: STEP_TIMEOUT_MS });
  await page.locator(selectors.microsoftButton).first().click();
  await onStep?.('microsoft-button', 'Clicked "Log In with Microsoft"');
  await page.waitForURL(/login\.microsoftonline\.com\/.*oauth2\/v2\.0\/authorize/i, {
    timeout: STEP_TIMEOUT_MS,
  }).catch(() => undefined);
  await page.waitForTimeout(TRANSITION_DELAY_MS);

  const firstState = await waitForAnyVisible(
    page,
    [selectors.emailInput, selectors.usePasswordLink, selectors.passwordInput],
    STEP_TIMEOUT_MS,
  );

  if (firstState === 'apollo-redirect') {
    await onStep?.('apollo-redirect', `Redirected back to Apollo: ${page.url()}`);
    return;
  }

  if (firstState === selectors.emailInput) {
    await submitEmail(page, email, options);
    await page.waitForTimeout(TRANSITION_DELAY_MS);
  } else if (firstState === selectors.usePasswordLink) {
    await page.locator(selectors.usePasswordLink).first().click();
    await onStep?.('use-password', 'Clicked "Use your password"');
    await page.waitForTimeout(TRANSITION_DELAY_MS);
  }

  await reachPasswordInput(page, email, options);
  await submitPassword(page, password, options);
  await handleStaySignedIn(page, { onStep, onRecoverableStepError });

  await page.waitForURL(/app\.apollo\.io(?!.*\/login)/i, { timeout: OAUTH_TIMEOUT_MS });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await onStep?.('apollo-redirect', `Redirected back to Apollo: ${page.url()}`);
}
