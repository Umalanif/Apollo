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
import * as path from 'path';
import { getEnv } from './env/schema';
import { logger } from './logger';
import { detectChallenge, ChallengeDetection } from './challenge-detector';
import { ChallengeBypassSignal } from './errors';
import { AuthManager } from './services/auth.service';

// ── Proxy URL builder ─────────────────────────────────────────────────────────

export function buildProxyUrl(port: number = 10000): string {
  const { PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD } = getEnv();
  return `http://${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_HOST}:${port}`;
}

/** Proxy components for explicit Playwright configuration */
export function getProxyComponents(port: number = 10000) {
  const { PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD } = getEnv();
  return {
    server: `http://${PROXY_HOST}:${port}`,
    username: PROXY_USERNAME,
    password: PROXY_PASSWORD,
  };
}


// ── Session warm-up helper ─────────────────────────────────────────────────────

/**
 * Navigate to Apollo home page, wait for background scripts to load,
 * validate session via page title, then set the target hash route.
 *
 * Returns when the page is stable on the target hash, or throws
 * ChallengeBypassSignal on fatal rejection.
 */
async function warmUpAndNavigateToHash(
  page: Page,
  hashPath: string,
  jobId: string,
): Promise<void> {
  // Build target URL — navigate DIRECTLY to the hash route, not to home first.
  // Apollo's SPA will redirect to #/login?redirectTo=... if session is invalid.
  // Keep the leading '#' so URL is https://app.apollo.io/#/people (not //people)
  const url = `https://app.apollo.io/${hashPath}`;
  logger.debug({ jobId, url }, 'Warm-up: navigating directly to target URL');
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Wait for React app to settle (either stay on target route or redirect to login)
  await page.waitForFunction(
    () => {
      return !window.location.href.includes('#/login?redirectTo=') || window.location.hash.startsWith('#/login');
    },
    { timeout: 20_000 },
  ).catch(() => {
    logger.debug({ jobId }, 'Warm-up: URL stability check timed out — continuing anyway');
  });

  // Validate session via page title — if login page detected, trigger auto-login
  const title = await page.title();
  logger.debug({ jobId, title }, 'Warm-up: page title received');

  if (title.toLowerCase().includes('log in') || title.toLowerCase().includes('login') || page.url().includes('/login')) {
    logger.warn({ jobId, title }, 'Log In page detected — triggering auto-login');
    await AuthManager.ensureAuthenticated(page, jobId);
  }

  // Wait for hash router to process
  await page.waitForFunction(
    (expectedHash: string) => window.location.hash.startsWith(expectedHash.split('?')[0]),
    hashPath.split('?')[0],
    { timeout: 15_000 },
  ).catch(err => {
    logger.warn({ jobId, hash: hashPath }, `Hash router wait failed: ${err.message}`);
  });

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
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(120_000);

  // Inject stealth evasions via page.evaluate
  await page.addInitScript(() => {
    const hostname = window.location.hostname;
    const isMicrosoftAuthHost = [
      'microsoftonline.com',
      'microsoft.com',
      'msftauth.net',
    ].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
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

    // window.chrome — ONLY expose minimal chrome.runtime stub.
    // WARNING: chrome.app and chrome.runtime cause "Cannot redefine property: chrome"
    // errors in Microsoft OAuth popup windows. Only use basic stubs here.
    if (!isMicrosoftAuthHost) {
      if ((globalThis as unknown as Record<string, unknown>).chrome === undefined) {
        (globalThis as unknown as Record<string, unknown>).chrome = {};
      }
      Object.defineProperty(globalThis, 'chrome', {
        get: () => ({
          loadTimes: () => ({}),
          csi: () => ({}),
        }),
        configurable: true,
      });
    }

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

  // ── Proxy authentication header injection ─────────────────────────────────
  // The proxy requires Basic auth — inject into headers on every request
  // This is handled by Playwright's proxy configuration, no extra work needed.
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

const MICROSOFT_AUTH_HOST_PATTERNS = [
  'microsoftonline.com',
  'microsoft.com',
  'msftauth.net',
];

function isMicrosoftAuthUrl(url: string): boolean {
  return MICROSOFT_AUTH_HOST_PATTERNS.some(pattern => url.includes(pattern));
}

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
  const { PROXY_HOST } = getEnv();

  logger.info(
    { jobId, proxyPort, proxyHost: `http://${PROXY_HOST}:${proxyPort}` },
    'Creating PlaywrightCrawler',
  );

  const proxyComponents = getProxyComponents(proxyPort);

  const crawler = new PlaywrightCrawler({
    // ── Concurrency: single page — anti-detection ─────────────────────────────
    maxConcurrency: 1,
    maxRequestRetries: 2,

    // ── Proxy: explicit auth — bypasses ProxyConfiguration abstraction ──────
    proxyConfiguration: new ProxyConfiguration({ proxyUrls: [buildProxyUrl(proxyPort)] }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    launchContext: {
      // Persistent Profile: saves FRESH Cloudflare cookies natively
      // userDataDir at launchContext level triggers launchPersistentContext internally
      userDataDir: path.join(process.cwd(), 'storage/browser_profile'),
      launchOptions: {
        // 1. Explicit Proxy Auth: fixes ERR_TUNNEL_CONNECTION_FAILED
        proxy: {
          server: `http://${proxyComponents.server.replace('http://', '')}`,
          username: proxyComponents.username,
          password: proxyComponents.password,
        },
        // 2. Headful mode for CDN debugging + slowMo for visual following
        headless: false,
        slowMo: 1000,
        // 3. Automation flag + proxy bypass for Microsoft OAuth domains
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          // Bypass proxy for Microsoft auth/CDN domains so OAuth popup renders correctly
          '--proxy-bypass-list=*.microsoftonline.com,*.msauth.net,*.msftauth.net,*.live.com,*.microsoft.com',
        ],
      },
    } as any,

    // ── Navigation hooks ────────────────────────────────────────────────────
    preNavigationHooks: [preNavigationHook],

    // ── Request handler ──────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requestHandler: async ({ page, request }: { page: Page; request: any }) => {
      // ── Set User-Agent from Brave ───────────────────────────────────────────
      const { APOLLO_EMAIL, APOLLO_PASSWORD } = getEnv();
      if (APOLLO_EMAIL && APOLLO_PASSWORD) {
        // Auto-login credentials available — logging for future Phase 16.2
        logger.debug({ jobId, email: APOLLO_EMAIL.slice(0, 3) + '***' }, 'Apollo credentials available for auto-login');
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
        if (isMicrosoftAuthUrl(url)) {
          return route.continue();
        }

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
