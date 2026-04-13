import { chromium, type BrowserContext, type ConsoleMessage, type Page } from 'playwright';
import { extractSessionAuth } from './extractor';

const SMOKE_TEST_URL = 'https://app.apollo.io/#/login?locale=en';
const OBSERVATION_MS = 30_000;

const BLOCKED_DOMAINS = new Set([
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'facebook.com',
  'hotjar.com',
  'segment.com',
  'mixpanel.com',
  'intercom.io',
  'sentry.io',
  '2o7.net',
  'omtrdc.net',
  'branch.io',
  'amplitude.com',
  'heap.io',
  'heapanalytics.com',
  'fullstory.com',
  'crazyegg.com',
  'mouseflow.com',
  'inspectlet.com',
  'mousestats.com',
  'luckyorange.com',
  'clarity.ms',
]);

const BLOCKED_TYPES = new Set([
  'image',
  'font',
  'media',
  'stylesheet',
  'websocket',
  'preflight',
]);

const MICROSOFT_AUTH_HOST_PATTERNS = [
  'microsoftonline.com',
  'microsoft.com',
  'msauth.net',
  'msftauth.net',
  'live.com',
];

function isMicrosoftAuthUrl(url: string): boolean {
  return MICROSOFT_AUTH_HOST_PATTERNS.some(pattern => url.includes(pattern));
}

function isBlockedDomain(hostname: string): boolean {
  if (BLOCKED_DOMAINS.has(hostname)) {
    return true;
  }

  for (const blocked of BLOCKED_DOMAINS) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      return true;
    }
  }

  return false;
}

async function applyStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const hostname = window.location.hostname;
    const isMicrosoftAuthHost = [
      'microsoftonline.com',
      'microsoft.com',
      'msauth.net',
      'msftauth.net',
      'live.com',
    ].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));

    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    });

    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        {
          name: 'Chrome PDF Plugin',
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
        },
        {
          name: 'Chrome PDF Viewer',
          description: '',
          filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
        },
        {
          name: 'Native Client',
          description: '',
          filename: 'internal-nacl-plugin',
        },
      ],
      configurable: true,
    });

    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
      configurable: true,
    });

    if (!isMicrosoftAuthHost) {
      if ((globalThis as Record<string, unknown>).chrome === undefined) {
        (globalThis as Record<string, unknown>).chrome = {};
      }
      Object.defineProperty(globalThis, 'chrome', {
        get: () => ({
          loadTimes: () => ({}),
          csi: () => ({}),
        }),
        configurable: true,
      });
    }

    const permissions = navigator.permissions as Permissions & {
      query?: (permissionDesc: PermissionDescriptor) => Promise<PermissionStatus>;
    };
    const origQuery = permissions.query?.bind(permissions);
    if (origQuery) {
      (permissions as Permissions & {
        query: (permissionDesc: PermissionDescriptor) => Promise<PermissionStatus>;
      }).query = (params: PermissionDescriptor) =>
        origQuery(params).catch(() => Promise.resolve({ state: 'denied' } as PermissionStatus));
    }

    const origGetContext = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as any).getContext = function (...args: unknown[]) {
      return origGetContext.apply(this, args as Parameters<typeof origGetContext>);
    };
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () =>
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      configurable: true,
    });
  });
}

function logConsoleMessage(msg: ConsoleMessage): void {
  const location = msg.location();
  const suffix = location.url ? ` (${location.url}:${location.lineNumber}:${location.columnNumber})` : '';
  console.log(`[console:${msg.type()}] ${msg.text()}${suffix}`);
}

async function logApolloCookies(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  const apolloCookies = cookies.filter(cookie => cookie.domain.includes('apollo.io'));
  console.log('[cookies] apollo.io cookies after load:');
  if (apolloCookies.length === 0) {
    console.log('  (none)');
    return;
  }

  for (const cookie of apolloCookies) {
    console.log(
      `  ${cookie.name}=${cookie.value}; domain=${cookie.domain}; path=${cookie.path}; httpOnly=${cookie.httpOnly}; secure=${cookie.secure}`,
    );
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 500,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--proxy-bypass-list=*.microsoftonline.com,*.msauth.net,*.msftauth.net,*.live.com,*.microsoft.com',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });

  await applyStealth(context);

  await context.route('**/*', async route => {
    const request = route.request();
    const url = request.url();
    const type = request.resourceType();

    if (isMicrosoftAuthUrl(url) || url.includes('apollo.io')) {
      await route.continue();
      return;
    }

    const hostname = new URL(url).hostname;
    if (isBlockedDomain(hostname) || BLOCKED_TYPES.has(type)) {
      await route.abort();
      return;
    }

    await route.continue();
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(120_000);

  page.on('console', logConsoleMessage);
  page.on('pageerror', error => {
    console.error(`[pageerror] ${error.name}: ${error.message}`);
  });
  page.on('requestfailed', request => {
    const failure = request.failure();
    console.error(`[requestfailed] ${request.url()} -> ${failure?.errorText ?? 'unknown'}`);
  });
  page.on('popup', popup => {
    attachPopupLogging(popup);
  });

  console.log(`[smoke] Navigating to ${SMOKE_TEST_URL}`);
  await page.goto(SMOKE_TEST_URL, { waitUntil: 'domcontentloaded' });

  await page.waitForLoadState('networkidle').catch(() => {
    console.log('[smoke] networkidle wait timed out; continuing with current page state');
  });

  // ── Microsoft OAuth Login Flow ─────────────────────────────────────────────
  const email = process.env.APOLLO_MS_EMAIL;
  const password = process.env.APOLLO_MS_PASSWORD;

  if (!email || !password) {
    console.error('[smoke] FATAL: APOLLO_MS_EMAIL and APOLLO_MS_PASSWORD must be set in .env');
    process.exitCode = 1;
    await browser.close();
    return;
  }

  console.log('[smoke] Starting Microsoft OAuth login flow');

  // Step 0: Click "Log In with Microsoft" button on Apollo login page
  try {
    const microsoftBtn = page.locator('button[data-cta-variant="secondary"]:has-text("Log In with Microsoft")').first();
    await microsoftBtn.waitFor({ timeout: 60_000 });
    console.log('[smoke] Step 0: "Log In with Microsoft" button visible — clicking it');
    await microsoftBtn.click();
    console.log('[smoke] Step 0: Clicked "Log In with Microsoft"');
  } catch (err) {
    console.error('[smoke] FAILURE at Step 0 (Microsoft button):', err instanceof Error ? err.message : err);
    process.exitCode = 1;
    await browser.close();
    return;
  }

  // Step 1: Wait for Microsoft email input
  try {
    const emailInput = page.locator('input[type="email"], input[name="loginfmt"]').first();
    await emailInput.waitFor({ timeout: 60_000 });
    console.log('[smoke] Step 1: Email input visible — filling email');
    await emailInput.fill(email);
    await page.locator('button[type="submit"], #idSIButton9, input[type="submit"]').first().click();
    console.log('[smoke] Step 1: Email submitted — clicked Next');
  } catch (err) {
    console.error('[smoke] FAILURE at Step 1 (email input):', err instanceof Error ? err.message : err);
    process.exitCode = 1;
    await browser.close();
    return;
  }

  // Step 2: Click "Use your password" link (Microsoft shows this before password input)
  try {
    await page.waitForTimeout(2000); // Allow page to render options
    const usePasswordLink = page.locator('span[role="button"]:has-text("Use your password")').first();
    await usePasswordLink.waitFor({ timeout: 60_000 });
    console.log('[smoke] Step 2: "Use your password" link visible — clicking it');
    await usePasswordLink.click();
    console.log('[smoke] Step 2: Clicked "Use your password"');
  } catch (err) {
    console.error('[smoke] FAILURE at Step 2 (Use your password link):', err instanceof Error ? err.message : err);
    process.exitCode = 1;
    await browser.close();
    return;
  }

  // Step 3: Wait for password field
  try {
    await page.waitForTimeout(2000); // Allow Microsoft to route to password page
    const passwordInput = page.locator('input[type="password"], input[name="passwd"]').first();
    await passwordInput.waitFor({ timeout: 60_000 });
    console.log('[smoke] Step 3: Password input visible — filling password');
    await passwordInput.fill(password);
    await page.locator('button[type="submit"], #idSIButton9, input[type="submit"]').first().click();
    console.log('[smoke] Step 3: Password submitted — clicked Sign in');
  } catch (err) {
    console.error('[smoke] FAILURE at Step 3 (password input):', err instanceof Error ? err.message : err);
    process.exitCode = 1;
    await browser.close();
    return;
  }

  // Step 4: Handle "Stay signed in?" prompt if it appears
  try {
    await page.waitForTimeout(2000); // Allow redirect to start
    const staySignedInBtn = page.locator('button[data-testid="primaryButton"]:has-text("Yes")').first();
    const isVisible = await staySignedInBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (isVisible) {
      console.log('[smoke] Step 4: "Stay signed in" prompt detected — clicking Yes');
      await staySignedInBtn.click();
    } else {
      console.log('[smoke] Step 4: "Stay signed in" prompt not visible — continuing');
    }
  } catch (err) {
    console.warn('[smoke] Step 4: KMSI check failed — continuing:', err instanceof Error ? err.message : err);
  }

  // Step 5: Wait for redirect back to apollo.io
  try {
    console.log('[smoke] Step 5: Waiting for redirect to app.apollo.io (timeout: 120s)');
    await page.waitForURL(/app\.apollo\.io(?!.*\/login)/i, { timeout: 120_000 });
    console.log('[smoke] Step 5: Redirected to apollo.io — URL matches target');
  } catch (err) {
    console.error('[smoke] FAILURE at Step 5 (redirect to apollo.io):', err instanceof Error ? err.message : err);
    process.exitCode = 1;
    await browser.close();
    return;
  }

  // Step 6: Call extractSessionAuth() and print results
  await page.waitForLoadState('networkidle').catch(() => {
    console.log('[smoke] networkidle wait timed out; continuing with current page state');
  });

  let authResult: Awaited<ReturnType<typeof extractSessionAuth>> | null = null;
  try {
    authResult = await extractSessionAuth(page);
  } catch (err) {
    console.error('[smoke] extractSessionAuth() threw:', err instanceof Error ? err.message : err);
  }

  const allCookies = await context.cookies();
  const apolloCookies = allCookies.filter(c => c.domain.includes('apollo.io'));

  console.log('[smoke] Step 6: extractSessionAuth() results:');
  console.log(`  Apollo cookie count: ${apolloCookies.length}`);
  console.log(`  CSRF token found: ${authResult?.csrfToken ? 'true' : 'false'}`);

  // Step 7: Print final verdict
  if (apolloCookies.length > 0) {
    console.log('[smoke] RESULT: SUCCESS — apollo.io cookies found after login');
  } else {
    console.error('[smoke] RESULT: FAILURE — no apollo.io cookies found after login');
    process.exitCode = 1;
  }

  console.log(`[smoke] Waiting ${OBSERVATION_MS / 1000}s for observation`);
  await page.waitForTimeout(OBSERVATION_MS);
  await browser.close();
}

function attachPopupLogging(popup: Page): void {
  popup.on('console', logConsoleMessage);
  popup.on('pageerror', error => {
    console.error(`[popup:pageerror] ${error.name}: ${error.message}`);
  });
  popup.on('requestfailed', request => {
    const failure = request.failure();
    console.error(`[popup:requestfailed] ${request.url()} -> ${failure?.errorText ?? 'unknown'}`);
  });
}

main().catch(error => {
  console.error('[smoke] Fatal error:', error);
  process.exitCode = 1;
});
