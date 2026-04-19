import type { Locator, Page } from 'playwright';

import { APOLLO_LOGIN_URL } from '../apollo-browser';
import { ManualAuthenticationRequiredError } from '../errors';

const OAUTH_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const TRANSITION_DELAY_MS = 3_000;
const NETWORK_SETTLE_TIMEOUT_MS = 10_000;
const FATAL_AUTH_MESSAGES = [
  'for security reasons, we have logged you out from all devices because your account has been logged in from multiple places',
  'logged you out from all devices',
  'logged in from multiple places',
  'we recommend changing your password immediately',
];

const selectors = {
  microsoftButton: 'button[data-cta-variant="secondary"], button, a',
  emailInput: '#i0116, input[type="email"], input[name="loginfmt"]',
  passwordInput: '#i0118, input[type="password"], input[name="passwd"]',
  submitButton: '#idSIButton9, button[type="submit"], input[type="submit"]',
  usePasswordLink: '#idA_PWD_SwitchToPassword, span[role="button"], button, a',
  staySignedInButton: '#idSIButton9, button[data-testid="primaryButton"], input[type="submit"], button[type="submit"]',
};
const USE_PASSWORD_PATTERNS = [
  'use your password',
  'kennwort verwenden',
  'kennwort eingeben',
  'use password',
];
const MICROSOFT_BUTTON_PATTERNS = ['microsoft'];
const STAY_SIGNED_IN_PATTERNS = [
  'stay signed in',
  'angemeldet bleiben',
  'signed in',
];
const DECLINE_PATTERNS = ['no', 'nein'];
const ACCEPT_PATTERNS = ['yes', 'ja'];

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

async function findFirstVisibleByText(page: Page, selector: string, patterns: string[]): Promise<Locator | null> {
  const locators = patterns.map(pattern =>
    page.locator(selector).filter({ hasText: new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first(),
  );

  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }

  return null;
}

async function findUsePasswordControl(page: Page): Promise<Locator | null> {
  const byId = page.locator('#idA_PWD_SwitchToPassword').first();
  if (await byId.isVisible().catch(() => false)) {
    return byId;
  }

  return findFirstVisibleByText(page, selectors.usePasswordLink, USE_PASSWORD_PATTERNS);
}

async function findMicrosoftButton(page: Page): Promise<Locator | null> {
  return findFirstVisibleByText(page, selectors.microsoftButton, MICROSOFT_BUTTON_PATTERNS);
}

function isApolloAuthenticatedUrl(url: string): boolean {
  return /app\.apollo\.io/i.test(url) && !/\/#\/login\b/i.test(url);
}

async function getFatalAuthMessage(page: Page): Promise<string | null> {
  const bodyText = (await page.locator('body').textContent().catch(() => '') ?? '').toLowerCase();
  const matchedMessage = FATAL_AUTH_MESSAGES.find(message => bodyText.includes(message));
  if (!matchedMessage) {
    return null;
  }

  return 'For security reasons, Microsoft logged the account out because it was used from multiple places';
}

async function waitForAnyVisible(page: Page, selectorList: string[], timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const fatalAuthMessage = await getFatalAuthMessage(page);
    if (fatalAuthMessage) {
      throw new ManualAuthenticationRequiredError(fatalAuthMessage);
    }

    for (const selector of selectorList) {
      if (selector === selectors.usePasswordLink) {
        if (await findUsePasswordControl(page)) {
          return selector;
        }
        continue;
      }

      if (await isVisible(page, selector)) {
        return selector;
      }
    }

    if (isApolloAuthenticatedUrl(page.url())) {
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
      const usePasswordControl = await findUsePasswordControl(page);
      if (!usePasswordControl) {
        throw new Error('Microsoft "use password" control was detected but not clickable');
      }
      await usePasswordControl.click();
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

  const bodyText = (await page.locator('body').textContent().catch(() => '') ?? '').toLowerCase();
  const looksLikeStaySignedInPrompt = STAY_SIGNED_IN_PATTERNS.some(pattern => bodyText.includes(pattern));
  if (!looksLikeStaySignedInPrompt) {
    await hooks.onStep?.('kmsi', 'KMSI prompt not visible');
    return;
  }

  try {
    const localizedDeclineButton = await findFirstVisibleByText(page, selectors.staySignedInButton, DECLINE_PATTERNS);
    const fallbackDeclineButton = page.locator('#idBtn_Back').first();
    const fallbackPrimaryButton = page.locator('#idSIButton9').first();
    const targetButton = localizedDeclineButton
      ?? ((await fallbackDeclineButton.isVisible().catch(() => false)) ? fallbackDeclineButton : null)
      ?? await findFirstVisibleByText(page, selectors.staySignedInButton, ACCEPT_PATTERNS)
      ?? ((await fallbackPrimaryButton.isVisible().catch(() => false)) ? fallbackPrimaryButton : null);

    if (!targetButton) {
      await hooks.onStep?.('kmsi', 'KMSI prompt detected but primary button not visible');
      return;
    }

    await targetButton.click();
    await hooks.onStep?.('kmsi', targetButton === fallbackPrimaryButton ? 'Accepted KMSI' : 'Declined KMSI');
  } catch (error) {
    await hooks.onRecoverableStepError?.('kmsi', error);
  }
}

async function waitForApolloApp(page: Page): Promise<void> {
  const deadline = Date.now() + OAUTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const fatalAuthMessage = await getFatalAuthMessage(page);
    if (fatalAuthMessage) {
      throw new ManualAuthenticationRequiredError(fatalAuthMessage);
    }

    if (isApolloAuthenticatedUrl(page.url())) {
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(2_000);
      return;
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  throw new Error('Microsoft SSO did not redirect back to Apollo');
}

export async function runMicrosoftApolloLogin(page: Page, options: MicrosoftLoginOptions): Promise<void> {
  const { email, password, onStep, onRecoverableStepError } = options;

  page.setDefaultNavigationTimeout(OAUTH_TIMEOUT_MS);
  page.setDefaultTimeout(OAUTH_TIMEOUT_MS);

  await page.goto(APOLLO_LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: OAUTH_TIMEOUT_MS,
  });
  await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_TIMEOUT_MS }).catch(() => undefined);
  await onStep?.('open-login', 'Opened Apollo login page');

  if (isApolloAuthenticatedUrl(page.url())) {
    await onStep?.('apollo-redirect', `Apollo session already active: ${page.url()}`);
    return;
  }

  const microsoftButton = await findMicrosoftButton(page);
  if (!microsoftButton) {
    throw new Error('Apollo Microsoft login button was not visible');
  }
  await microsoftButton.click();
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
    await waitForApolloApp(page);
    await onStep?.('apollo-redirect', `Redirected back to Apollo: ${page.url()}`);
    return;
  }

  if (firstState === selectors.emailInput) {
    await submitEmail(page, email, options);
    await page.waitForTimeout(TRANSITION_DELAY_MS);
  } else if (firstState === selectors.usePasswordLink) {
    const usePasswordControl = await findUsePasswordControl(page);
    if (!usePasswordControl) {
      throw new Error('Microsoft "use password" control did not remain visible');
    }
    await usePasswordControl.click();
    await onStep?.('use-password', 'Clicked "Use your password"');
    await page.waitForTimeout(TRANSITION_DELAY_MS);
  }

  await reachPasswordInput(page, email, options);
  await submitPassword(page, password, options);
  await handleStaySignedIn(page, { onStep, onRecoverableStepError });

  await waitForApolloApp(page);
  await onStep?.('apollo-redirect', `Redirected back to Apollo: ${page.url()}`);
}
