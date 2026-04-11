/**
 * Crawler factory — PlaywrightCrawler + stealth evasions + proxy + blocking
 *
 * Phase 6.1: Initialize PlaywrightCrawler with puppeteer-extra-plugin-stealth evasions
 * Phase 6.2: Aggressive blocking via route interception
 * Phase 6.3: Proxy generation (DataImpulse sticky proxy, port starts 10000)
 * Phase 6.5: Concurrency locked to 1
 *
 * Usage:
 *   const crawler = await createCrawler({ jobId, proxyPort? });
 *   await crawler.run([{ url: 'https://app.apollo.io/people?...' }]);
 */

import { PlaywrightCrawler } from 'crawlee';
import { ProxyConfiguration } from '@crawlee/core';
import type { Page } from 'playwright';
import { getEnv } from './env/schema';
import { logger } from './logger';
import { detectChallenge, ChallengeDetection } from './challenge-detector';
import { ChallengeBypassSignal, InvalidSessionCookieError } from './errors';

// ── Proxy URL builder ─────────────────────────────────────────────────────────

export function buildProxyUrl(port: number = 10000): string {
  const { PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD } = getEnv();
  return `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_HOST}:${port}`;
}

// ── Apollo cookie hydration ─────────────────────────────────────────────────────

interface CookieDef {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}

function parseCookieString(cookieStr: string): CookieDef[] {
  // Handle JSON array format (e.g. from browser cookie dump in .env)
  if (cookieStr.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(cookieStr) as Array<{
        name: string;
        value: string;
        domain?: string;
        path?: string;
        secure?: boolean;
        httpOnly?: boolean;
      }>;
      return parsed.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain ?? '.apollo.io',
        path: c.path ?? '/',
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
      }));
    } catch {
      // Fall through to semicolon-split parsing
    }
  }
  // Handle semicolon-separated cookie string
  return cookieStr.split(';').map(cookieStr => {
    const [name, ...rest] = cookieStr.trim().split('=');
    return {
      name: name.trim(),
      value: rest.join('=').trim(),
      domain: '.apollo.io',
      path: '/',
      secure: true,
      httpOnly: false,
    };
  });
}

// ── Session warm-up helper ─────────────────────────────────────────────────────

/**
 * Navigate to Apollo home page, wait for background scripts to load,
 * validate session via page title, then set the target hash route.
 *
 * Returns when the page is stable on the target hash, or throws
 * InvalidSessionCookieError / ChallengeBypassSignal on fatal rejection.
 */
async function warmUpAndNavigateToHash(
  page: Page,
  hashPath: string,
  jobId: string,
): Promise<void> {
  const HOME_URL = 'https://app.apollo.io/';
  const WARM_UP_MS = 6_000; // 5-7 seconds for Segment/Sentry/Datadog to load

  // Step 1: Navigate to Apollo home to initialize the React app
  logger.debug({ jobId, url: HOME_URL }, 'Warm-up: navigating to Apollo home');
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });

  // Step 2: Wait for background scripts (Segment, Sentry, Datadog) to load
  logger.debug({ jobId, waitMs: WARM_UP_MS }, 'Warm-up: waiting for background scripts');
  await page.waitForTimeout(WARM_UP_MS);

  // Step 3: Validate session via page title
  const title = await page.title();
  logger.debug({ jobId, title }, 'Warm-up: page title received');

  if (title.toLowerCase().includes('log in')) {
    logger.error({ jobId, title }, 'SESSION_REJECTED — cookies rejected, need fresh session');
    throw new InvalidSessionCookieError(
      `Session cookie rejected — page title is "${title}"`,
    );
  }

  // Title should contain "Home" or "Dashboard" for a valid authenticated session
  const hasValidTitle = title.toLowerCase().includes('home') ||
                        title.toLowerCase().includes('dashboard');
  if (!hasValidTitle) {
    logger.warn({ jobId, title }, 'Warm-up: unexpected page title — proceeding anyway');
  }

  // Step 4: Set the hash route via JavaScript
  logger.debug({ jobId, hashPath }, 'Warm-up: setting window.location.hash');
  await page.evaluate((hash: string) => {
    window.location.hash = hash;
  }, hashPath);

  // Step 5: Wait for hash router to process
  await page.waitForFunction(
    (expectedHash: string) => window.location.hash.startsWith(expectedHash.split('?')[0]),
    hashPath.split('?')[0],
    { timeout: 15_000 },
  ).catch(err => {
    logger.warn({ jobId, hash: hashPath }, `Hash router wait failed: ${err.message}`);
  });

  // Step 6: Detect "Get Started" — Apollo's redirect when session is marginal
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes('Get Started')) {
    logger.warn({ jobId }, 'Get Started detected after hash navigation — reloading once');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WARM_UP_MS);

    const bodyTextAfterReload = await page.evaluate(() => document.body.innerText);
    if (bodyTextAfterReload.includes('Get Started')) {
      logger.error({ jobId }, 'Get Started still present after reload — giving up');
      throw new ChallengeBypassSignal('get_started_redirect', page.url());
    }
  }

  logger.info({ jobId, hash: hashPath }, 'Warm-up: hash routing complete');
}

// ── Stealth evasions (from puppeteer-extra-plugin-stealth/evasions) ────────────

/**
 * Pre-navigation hook: apply stealth evasions + inject Apollo session cookies.
 * Called before every page navigation inside the Playwright browser.
 */
async function preNavigationHook(
  crawlingContext: { page: import('playwright').Page },
  _gotoOptions: unknown,
): Promise<void> {
  const { page } = crawlingContext;
  const { APOLLO_SESSION_COOKIE } = getEnv();

  // Inject stealth evasions via page.evaluate
  await page.addInitScript(() => {
    // navigator.webdriver = false
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    });

    // navigator.plugins — expose a realistic plugin array
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
          filename: 'mhjfbmdgcfjbbpaeojk',
      },
      {
        name: 'Native Client',
        description: '',
        filename: 'internal-nacl-plugin',
      },
      ],
      configurable: true,
    });

    // navigator.hardwareConcurrency — fake core count
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
      configurable: true,
    });

    // window.chrome — enable chrome.runtime
    if ((globalThis as unknown as Record<string, unknown>).chrome === undefined) {
      (globalThis as unknown as Record<string, unknown>).chrome = {};
    }
    Object.defineProperty(globalThis, 'chrome', {
      get: () => ({
        runtime: {},
        loadTimes: () => ({}),
        csi: () => ({}),
        app: {},
      }),
      configurable: true,
    });

    // navigator.permissions — fake permissions API
    const origQuery = (navigator.permissions as unknown as { query: (params: { name: string }) => Promise<{ status: string }> }).query;
    if (origQuery) {
      (navigator.permissions as unknown as { query: (params: { name: string }) => Promise<{ status: string }> }).query = (params: { name: string }) =>
        origQuery(params).catch(() => Promise.resolve({ status: 'denied' }));
    }

    // WebGL vendor/renderer — simplified, no return-type mutation
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).getContext = function (
      contextId: string,
      ...args: unknown[]
    ) {
      return origGetContext.call(this, contextId, ...args);
    };
  });

  // Override navigator.userAgent so page fingerprinting sees the fake Chrome UA
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      configurable: true,
    });
  });

  // Hydrate session cookies for Apollo
  if (APOLLO_SESSION_COOKIE) {
    const cookies = parseCookieString(APOLLO_SESSION_COOKIE);
    await page.context().addCookies(cookies);
    logger.debug({ cookieCount: cookies.length }, 'Apollo session cookies injected');
  }

  // ── Phase 7.5: Session health check after cookie injection ─────────────────
  // Verify the session is still valid by hitting the auth health endpoint.
  // If the API returns 401 / Login Required, throw InvalidSessionCookieError
  // to trigger proxy rotation with a fresh session cookie.
  try {
    const healthResponse = await page.evaluate(async () => {
      const res = await fetch('https://app.apollo.io/api/v1/auth/health', {
        credentials: 'include',
      });
      return { status: res.status, ok: res.ok };
    });

    if (healthResponse.status === 401 || !healthResponse.ok) {
      logger.warn({ healthStatus: healthResponse.status }, 'Session health check failed — INVALID_SESSION_COOKIE');
      throw new InvalidSessionCookieError(
        `Session cookie rejected — auth health endpoint returned ${healthResponse.status}`,
      );
    }

    logger.debug({ healthStatus: healthResponse.status }, 'Session health check passed');
  } catch (err) {
    if (err instanceof InvalidSessionCookieError) {
      throw err; // re-throw to propagate to worker retry loop
    }
    // Network / fetch errors are non-fatal — log and continue
    logger.warn({ err: String(err) }, 'Session health check error (non-fatal)');
  }
}

// ── Resource blocker ───────────────────────────────────────────────────────────

const BLOCKED_DOMAINS = new Set([
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'facebook.com/tr',
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
  'bing.com/page.html',
  'bing.com/uchom',
]);

const BLOCKED_TYPES = new Set([
  'image',
  'font',
  'media',
  'stylesheet',
  'websocket',
  'preflight',
]);

// ── Crawler factory ─────────────────────────────────────────────────────────────

export interface CrawlerDeps {
  jobId: string;
  proxyPort?: number;
  /**
   * Called when a challenge (Cloudflare/DataDome/reCAPTCHA) is detected on a page.
   * The `page` parameter lets the caller inject a solved CAPTCHA token directly
   * into the browser context before returning.
   */
  onChallengeDetected?: (detection: ChallengeDetection, url: string, page: Page) => void | Promise<void>;
  /**
   * Called after the page has fully loaded (post-challenge-detection), when the
   * `page` object is still live. Use this to extract data via `page.evaluate()`.
   */
  onPageReady?: (page: Page, url: string) => void | Promise<void>;
}

export async function createCrawler(deps: CrawlerDeps): Promise<PlaywrightCrawler> {
  const { jobId, proxyPort = 10000, onChallengeDetected, onPageReady } = deps;
  const proxyUrl = buildProxyUrl(proxyPort);

  logger.info(
    { jobId, proxyPort, proxyHost: proxyUrl.replace(/:[^:@]+@/, ':***@') },
    'Creating PlaywrightCrawler',
  );

  const crawler = new PlaywrightCrawler({
    // ── Concurrency: single page — anti-detection ─────────────────────────────
    maxConcurrency: 1,
    maxRequestRetries: 2,

    // ── Proxy ───────────────────────────────────────────────────────────────
    proxyConfiguration: new ProxyConfiguration({ proxyUrls: [proxyUrl] }),
    launchContext: {
      // Playwright launch options — add automation-controlled flag
      launchOptions: {
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
        ],
      },
    },

    // ── Navigation hooks ────────────────────────────────────────────────────
    preNavigationHooks: [preNavigationHook],

    // ── Request handler ──────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requestHandler: async ({ page, request }: { page: Page; request: any }) => {
      // ── Set User-Agent from Brave ───────────────────────────────────────────
      const { BRAVE_USER_AGENT } = getEnv();
      if (BRAVE_USER_AGENT) {
        await page.context().setExtraHTTPHeaders({ 'User-Agent': BRAVE_USER_AGENT });
        logger.debug({ jobId, userAgent: BRAVE_USER_AGENT.slice(0, 50) }, 'Brave User-Agent set via headers');
      }

      // ── Log requestfailed events ────────────────────────────────────────────
      page.on('requestfailed', (req) => {
        const failure = req.failure();
        logger.warn(
          { jobId, url: req.url(), failure: failure?.errorText ?? 'unknown' },
          'Request failed',
        );
      });

      // ── Route interception: block heavy / tracking resources ───────────────
      await page.route('**/*', async route => {
        const url = route.request().url();
        const type = route.request().resourceType();

        // Always allow Apollo — needed for API calls
        if (url.includes('apollo.io')) {
          return route.continue();
        }

        // Block known tracking domains
        const urlObj = new URL(url);
        if (BLOCKED_DOMAINS.has(urlObj.hostname)) {
          return route.abort();
        }

        // Block heavy resource types (images, fonts, media)
        if (BLOCKED_TYPES.has(type)) {
          return route.abort();
        }

        return route.continue();
      });

      logger.info({ jobId, url: request.url }, `[${jobId}] Processing request`);

      // ── SPA Hash Routing: Apollo uses client-side hash routing (#/people) ────
      // page.goto('https://app.apollo.io/#/people?search[x]=y') does NOT work because
      // the hash + query are never sent to the server — the SPA must set window.location.hash.
      //
      // Warm-up sequence:
      //   1. Navigate to https://app.apollo.io/ (home) to initialize React app
      //   2. Wait 5-7 seconds for Segment, Sentry, Datadog background scripts
      //   3. Check page title — if "Log In" → SESSION_REJECTED; if "Home"/"Dashboard" → valid
      //   4. Set hash route via window.location.hash
      //   5. If "Get Started" detected → reload once before giving up
      const requestUrl = request.url as string;
      if (requestUrl.includes('#/')) {
        const urlObj = new URL(requestUrl);
        const hashPath = urlObj.hash; // e.g. "#/people?search[title]=engineer&..."

        // Warm-up navigation replaces the old 4-step inline SPA routing
        await warmUpAndNavigateToHash(page, hashPath, jobId);
      }

      // ── Phase 7.3: DOM challenge detection ─────────────────────────────────
      // Scan page DOM for Cloudflare / DataDome / reCAPTCHA markers.
      // The onChallengeDetected callback lets the caller (worker loop) decide
      // whether to solve (Phase 7.4) or bail + rotate proxy (Phase 7.5/7.6).
      //
      // ChallengeBypassSignal MUST propagate to the crawler's error handler so
      // the request is marked failed and the worker retry loop can rotate proxy.
      // We catch it here only to re-throw AFTER all processing so it propagates
      // OUTSIDE any nested try/catch.
      let challengeSignal: Error | null = null;

      // ── Phase 7.5: API Response Interception ────────────────────────────────
      // Apollo fetches people data via API (e.g., api/v1/mixed_search).
      // We intercept the response as a fallback if DOM extraction fails.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let capturedApiData: any = null;
      const apiInterceptorPromise = page.waitForResponse(
        (response) => {
          const url = response.url();
          // Intercept mixed_search API which returns people data
          // Also intercept people search API endpoints
          return url.includes('mixed_search') || url.includes('/api/v1/people');
        },
        { timeout: 30_000 },
      ).then(async (response) => {
        try {
          const contentType = response.headers()['content-type'] ?? '';
          if (contentType.includes('application/json')) {
            capturedApiData = await response.json();
            logger.info({ jobId, url: response.url(), keys: Object.keys(capturedApiData) }, 'API response intercepted');
          }
        } catch (err) {
          logger.warn({ jobId, err: String(err) }, 'Failed to parse intercepted API response');
        }
      }).catch(() => {
        // API interception is optional fallback — don't fail if no response captured
        logger.debug({ jobId }, 'API interception timed out (non-fatal)');
      });

      try {
        const detection = await detectChallenge(page);
        if (detection.type !== null) {
          logger.warn(
            { jobId, challengeType: detection.type, sitekey: detection.sitekey },
            `[${jobId}] Challenge detected: ${detection.message}`,
          );
          // onChallengeDetected may be sync (Cloudflare/DataDome → throws bypass signal)
          // or async (reCAPTCHA → awaits 2captcha solve → injects token → returns).
          // We await it so async handlers complete before the page continues.
          const result = onChallengeDetected?.(detection, request.url, page);
          if (result instanceof Promise) {
            await result;
          }
        }
      } catch (err) {
        // ChallengeBypassSignal thrown from onChallengeDetected — re-throw AFTER
        // this try/catch so it propagates to the crawler's request handler and
        // marks the request as failed, triggering the worker's retry loop.
        if (err instanceof ChallengeBypassSignal) {
          challengeSignal = err;
        } else {
          // Non-fatal: other challenge detection errors should not crash crawler
          logger.debug({ jobId, err: String(err) }, 'Challenge detection error (non-fatal)');
        }
      }

      // ── Phase 8: onPageReady callback — extract leads from live page ─────────
      // Wait for API interception to complete first, then pass captured data
      if (onPageReady && !challengeSignal) {
        try {
          // Ensure API interception has had a chance to capture data
          await apiInterceptorPromise;
          // Inject captured API data into browser's window object for page.evaluate access
          if (capturedApiData) {
            await page.evaluate((data: unknown) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (window as any)._capturedApiData = data;
            }, capturedApiData);
          }
          const result = onPageReady(page, request.url);
          if (result instanceof Promise) {
            await result;
          }
        } catch (err) {
          // Non-fatal: extraction errors should not crash the crawler
          logger.error({ jobId, err: String(err) }, 'onPageReady error (non-fatal)');
        }
      }

      // Propagate ChallengeBypassSignal AFTER all processing so Crawlee sees it
      // as an error from the request handler (not from a callback).
      if (challengeSignal) {
        throw challengeSignal;
      }
    },

    // Session pool disabled — each retry cycle creates a fresh crawler with a new
    // browser context. Cookie persistence is handled by the session cookie we inject.
    useSessionPool: false,
  });

  return crawler;
}
