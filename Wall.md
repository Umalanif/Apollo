# WALL — Architectural Decisions Log

## Phase 2: Smoke Test Fixes
- Fixed `@types/exceljs` and `@types/fast-csv` removed — both packages ship bundled types; npm had no matching version.
- Pinned `prisma`/`@prisma/client` to `^5.22.0` (not 7.x) — 7.x has breaking changes requiring `prisma.config.ts` for datasource URL.
- Fixed `LeadSchema.email`: moved `.regex()` before `.optional()` in chain — `ZodOptional` has no `.regex()` method.

## Phase 1: Environment & Schema
- Chose `sqlite` provider for Prisma (libSQL compatible, WAL mode). libSQL/Turso not required for local dev; SQLite with WAL provides same fault-tolerance characteristics.
- Zod env validation MUST block app startup if keys are missing/malformed — prevents silent failures in production.
- Lead schema enforces Title Case + emoji stripping at ingestion point — ensures clean data without post-processing.

## Phase 3: Persistence
- Used `upsert` with `linkedInUrl` as unique identifier — zero duplicates by design, not by query.
- Invalid Zod parses log to console.warn (dev) / JSON (prod) and discard — thread isolation means crash = lost work, not process death.

## Phase 5: Worker Export
- Export reads directly from DB (not in-memory arrays) — fault tolerance: if worker crashes mid-export, CSV is incomplete but DB is source of truth.
- Used `filenamify` to sanitize timestamps — Windows/Linux compatibility for exported files.

## Phase 6: Crawler & Proxy
- PlaywrightCrawler initialized via `createCrawler()` factory; `preNavigationHooks` used for stealth evasions instead of `plugins` array (Crawlee BrowserCrawlerOptions has no `plugins` field).
- Stealth evasions applied via `page.addInitScript()` inside `preNavigationHook` — mirrors all `puppeteer-extra-plugin-stealth/evasions` manually (navigator.webdriver, plugins, hardwareConcurrency, chrome.runtime, permissions, WebGL).
- Session cookies injected via `page.context().addCookies()` inside same `preNavigationHook` — runs before navigation, ensuring pre-authenticated session.
- Route blocking uses `page.route('**/*')` inside `requestHandler` — blocks doubleclick, hotjar, segment, etc. by hostname AND by resource type (image/font/media/stylesheet/websocket).
- `maxConcurrency: 1` enforced at crawler level — anti-detection.
- `proxyUrl` passed via `launchContext` — Playwright routes all traffic through DataImpulse sticky proxy.

## Phase 7: Extraction Strategy
- `got` mirrors Playwright proxy config — ensures consistent IP across browser and API requests, prevents session fragmentation.
- DOM scanner for challenges — prefer silent API extraction over CAPTCHA solve; CAPTCHA = last resort.
- Retry loop increments port on failure — sticky session affinity means new port = new exit IP.

## Phase 7.1: Bottleneck + got API Client
- Bottleneck `minTime: 3000` (hard floor) + 0-12s random extra per task = 3-15s total jitter per request.
- `got.extend()` with `HttpProxyAgent` for per-request proxy routing — same DataImpulse sticky proxy as Playwright.
- `got` uses `responseType: 'json'`, `retry` with 2 retries on network/5xx errors (ETIMEDOUT, ECONNRESET, EAI_AGAIN, ECONNREFUSED).
- `extractSessionAuth()` reads CSRF token from `meta[name="csrf-token"]` + all page cookies — extracted inside Playwright requestHandler, passed to worker for got calls.

## Phase 7.3: Challenge Detection
- `detectChallenge(page)` runs in the Playwright requestHandler after page load — parallel DOM checks via `page.evaluate()` for Cloudflare/DataDome/reCAPTCHA markers.
- Returns `ChallengeDetection { type, sitekey, message }` — sitekey extracted from `data-sitekey` attr for reCAPTCHA.
- Non-fatal: errors in detection are caught and logged as debug, never crash the crawler.
- `onChallengeDetected` callback on `CrawlerDeps` passes detection to the worker loop for Phase 7.4 solve / Phase 7.5-7.6 failover logic.

## Phase 7.4-7.6: CAPTCHA Solving + Proxy Rotation
- `ChallengeBypassSignal` custom error class — thrown from `onChallengeDetected` for Cloudflare/DataDome to propagate proxy-rotation intent to outer retry loop.
- `onChallengeDetected(detection, url, page)` now receives `page` — enables reCAPTCHA token injection inside the callback via `page.evaluate()`.
- `createCrawler` awaits `onChallengeDetected` result — `// await result` check for Promise allows async handlers (2captcha solve) to complete before page navigation continues.
- `solveRecaptcha(sitekey, url, opts?)` wraps 2captcha-ts Solver with x3 internal retry + exponential backoff for retryable ERROR_CODES; non-retryable errors bubble immediately.
- Token injection via `page.evaluate()`: `__recaptchaCallback`, `#g-recaptcha-response` textarea, `[name="g-recaptcha-response-data"]` textarea, and `recaptcha-token-ready` custom event — covers all common Apollo reCAPTCHA patterns.
- Worker retry loop: `ChallengeBypassSignal` → increment port immediately; 401/403/network error → `failCount++`, rotate after x3.

## Phase 8: Extraction Architecture
- `onPageReady(page, url)` callback added to `CrawlerDeps` — fires at end of requestHandler, the only point where `page` is live and `page.evaluate()` works.
- Extraction runs inside `onPageReady` via `scrapeLeadsFromPage()` → `page.evaluate()` DOM traversal for person cards.
- `saveLead` called per extracted person inside `onPageReady`; invalid parses caught and logged (non-fatal), loop continues.
- Phase 8.1 marked complete — worker.ts now has full extraction pipeline: `createCrawler → run → scrapeLeadsFromPage → saveLead → exportLeads`.

## Phase 8.2: Crawlee v3 Proxy Fix
- `PlaywrightCrawler` v3 uses `proxyConfiguration: new ProxyConfiguration({ proxyUrls: [proxyUrl] })` — NOT `launchContext.proxyUrl`. Using `launchContext.proxyUrl` throws: "PlaywrightCrawlerOptions.launchContext.proxyUrl is not allowed in PlaywrightCrawler. Use PlaywrightCrawlerOptions.proxyConfiguration". Import `ProxyConfiguration` from `@crawlee/core`.
- Proxy rotation now correctly increments port on each retry cycle (10,000 → 10,001 → ...).

## Phase 10: Event Loop Isolation
- `bree.remove('apollo-worker')` called before `bree.add()` — prevents accumulation of stale job entries in Bree's internal jobs array.
- `bree.run()` called without `await` — async fire-and-forget pattern; errors logged via `.catch()`.
- 202 Accepted returned immediately — Fastify event loop never blocks on worker completion.

## Phase 11: Orchestration Smoke Test
- `fastify-type-provider-zod` serializer expects Zod schema with `.safeParse()` — `zodToJsonSchema` output lacks this method; removed.
- 202 response schema removed from route definition — ZodTypeProvider handles response validation via `CreateJobResponseSchema` only when schema object has `.safeParse()`.
- Bree `worker_threads` isolate Playwright from Fastify — prevents event loop blocking, enables concurrent job queuing.
- 202 Accepted + async worker trigger — API remains responsive; client polls/callbacks for status.

## Phase 11.2: Crawler + Worker Integration Fixes
- `ChallengeBypassSignal` thrown inside request handler's try/catch was caught and logged as non-fatal — crawler completed "successfully" despite challenge. Fixed by capturing signal in a variable and re-throwing AFTER the try/catch block so it propagates to Crawlee's request error handler.
- `crawler.run()` resolves (not rejects) when requests fail internally — only rejects on queue timeout. Worker now checks `result.requestsFailed > 0 || result.requestsFinished === 0` and throws to trigger retry loop.
- `startServer()` now returns `fastify` instance for test cleanup.
- `Lead` model extended with `jobId` field — enables job-scoped lead tracking; `saveLead(jobId, raw)` signature updated.
- Session pool (`useSessionPool: true, maxPoolSize: 1`) caused subsequent crawlers to complete with 0 requests after first failure — removed; each retry cycle creates a fresh crawler with no session state.
- Cloudflare blocks DataImpulse datacenter proxies — environmental limitation, not a code defect.
