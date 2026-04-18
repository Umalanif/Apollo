import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page, Request } from 'playwright';
import { randomUUID } from 'node:crypto';
import { configureApolloPage } from './apollo-browser';
import { launchApolloContext } from './browser-launch';
import { attachPageDiagnostics } from './browser-diagnostics';
import { mutateHashScript } from './browser-context';
import { detectChallenge, type ChallengeDetection } from './challenge-detector';
import { ApolloResponseError, type ApolloResponseMeta, SessionTrustError } from './errors';
import { logger } from './logger';
import { safePageEvaluate, safePageScreenshot, safePageUrl } from './playwright-helpers';
import { runApolloSessionPreflight, warmupApolloSession } from './session-preflight';
import { AuthManager } from './services/auth.service';

export interface CrawlerDeps {
  jobId: string;
  launchAttempt?: number;
  onChallengeDetected?: (detection: ChallengeDetection, url: string, page: Page) => void | Promise<void>;
  onPeopleResponse?: (payload: unknown, responseMeta: ApolloResponseMeta, page: Page, url: string) => void | Promise<void>;
}

export interface ManagedCrawler {
  run: (requests: Array<{ url: string; uniqueKey?: string; userData?: { targetUrl?: string } }>) => Promise<{ requestsFinished: number; requestsFailed: number }>;
  teardown: () => Promise<void>;
  consumeTerminalError: () => Error | null;
}

interface ApolloRequestCapture {
  headers: Record<string, string>;
  method: string;
  postDataJson: unknown;
  requestUrl: string;
  responsePath: string;
  displayMode: string | null;
}

interface ApolloPeopleApiResponse {
  payload: unknown;
  responseMeta: ApolloResponseMeta;
}

type ApolloPeopleApiResult =
  | { ok: true; value: ApolloPeopleApiResponse }
  | { ok: false; error: unknown };

const PEOPLE_RESPONSE_TIMEOUT_MS = 180_000;
const APOLLO_SETTLE_TIMEOUT_MS = 10_000;
const INLINE_CHALLENGE_ATTEMPTS = 2;
const PRE_SEARCH_HUMAN_DELAY_MS = 7_000;
const APOLLO_PEOPLE_BASE_URL = 'https://app.apollo.io/#/people';
const APOLLO_PEOPLE_SEARCH_FIELDS = [
  'contact.id',
  'contact.name',
  'contact.contact_job_change_event',
  'contact.call_opted_out',
  'contact.first_name',
  'contact.last_name',
  'contact.original_source',
  'contact.next_contact_id',
  'contact.title',
  'contact.account',
  'contact.organization_id',
  'contact.intent_strength',
  'contact.organization_name',
  'contact.account.id',
  'contact.account.organization_id',
  'contact.account.domain',
  'contact.account.logo_url',
  'contact.account.name',
  'contact.account.facebook_url',
  'contact.account.linkedin_url',
  'contact.account.twitter_url',
  'contact.account.crm_record_url',
  'contact.account.website_url',
  'contact.contact_emails',
  'contact.email',
  'contact.email_status',
  'contact.free_domain',
  'contact.email_needs_tickling',
  'contact.email_status_unavailable_reason',
  'contact.email_true_status',
  'contact.email_domain_catchall',
  'contact.failed_email_verify_request',
  'contact.flagged_datum',
  'contact.phone_numbers',
  'contact.sanitized_phone',
  'contact.direct_dial_status',
  'contact.direct_dial_enrichment_failed_at',
  'contact.label_ids',
  'contact.linkedin_url',
  'contact.emailer_campaign_ids',
  'contact.twitter_url',
  'contact.facebook_url',
  'contact.crm_record_url',
  'contact.city',
  'contact.state',
  'contact.country',
  'account.estimated_num_employees',
  'account.industries',
  'account.keywords',
] as const;

const APOLLO_DEFAULT_PEOPLE_SEARCH_PAYLOAD: Record<string, unknown> = {
  page: 1,
  recommendation_config_id: 'score',
  sort_ascending: false,
  sort_by_field: 'recommendations_score',
  display_mode: 'explorer_mode',
  per_page: 30,
  open_factor_names: [],
  num_fetch_result: 1,
  context: 'people-index-page',
  show_suggestions: false,
  include_account_engagement_stats: false,
  include_contact_engagement_stats: false,
  finder_version: 2,
  fields: [...APOLLO_PEOPLE_SEARCH_FIELDS],
};

function extractChallengeSitekey(text: string): string | null {
  const match = text.match(/data-sitekey=["']([^"']+)["']/i);
  return match?.[1] ?? null;
}

export function detectChallengeTypeFromText(text: string): { challengeType: string | null; challengeSitekey: string | null } {
  const normalized = text.toLowerCase();
  const challengeSitekey = extractChallengeSitekey(text);

  if (normalized.includes('cf-turnstile') || normalized.includes('turnstile')) {
    return { challengeType: 'turnstile', challengeSitekey };
  }

  if (
    normalized.includes('challenges.cloudflare.com')
    || normalized.includes('cf-chl')
    || normalized.includes('cloudflare')
    || normalized.includes('verify you are a human')
    || normalized.includes('checking your browser')
  ) {
    return { challengeType: 'cloudflare', challengeSitekey };
  }

  if (
    normalized.includes('datadome')
    || normalized.includes('captcha-delivery.com')
  ) {
    return { challengeType: 'datadome', challengeSitekey };
  }

  if (
    normalized.includes('recaptcha')
    || normalized.includes('g-recaptcha')
  ) {
    return { challengeType: 'recaptcha', challengeSitekey };
  }

  if (
    normalized.includes('access denied')
    || normalized.includes('forbidden')
    || normalized.includes('too many requests')
    || normalized.includes('rate limit')
    || normalized.includes('unusual traffic')
    || normalized.includes('blocked')
  ) {
    return { challengeType: 'generic_block', challengeSitekey };
  }

  return { challengeType: null, challengeSitekey };
}

function buildResponseMeta(
  responseUrl: string,
  status: number,
  contentType: string,
  bodyText: string,
  challengeSitekey?: string | null,
  challengeSource: ApolloResponseMeta['challengeSource'] = null,
): ApolloResponseMeta {
  return {
    responseUrl,
    status,
    contentType,
    bodyPreview: bodyText.slice(0, 500),
    challengeSitekey,
    challengeSource,
  };
}

function extractResponsePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function readRequestHeaders(request: Request): Promise<Record<string, string>> {
  try {
    return await request.allHeaders();
  } catch {
    return request.headers();
  }
}

function parseRequestJson(request: Request): unknown {
  const postData = request.postData();
  if (!postData) {
    return {};
  }

  try {
    return JSON.parse(postData) as unknown;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function randomAlphaNumeric(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';

  while (result.length < length) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'a';
  }

  return result;
}

export function getApolloDisplayMode(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  return typeof payload.display_mode === 'string' ? payload.display_mode : null;
}

export function isCanonicalPeopleSearchCapture(responsePath: string, payload: unknown): boolean {
  return !responsePath.endsWith('/search_metadata_mode') && getApolloDisplayMode(payload) === 'explorer_mode';
}

function deriveTypedCustomFields(fields: string[]): string[] {
  return uniqueStrings(
    fields
      .map(field => {
        const match = field.match(/^(?:contact|account)\.([a-f0-9]{24})$/i);
        return match?.[1] ?? null;
      })
      .filter((value): value is string => value !== null),
  );
}

export function normalizePeopleSearchPayload(rawPayload: unknown, page: number = 1): Record<string, unknown> {
  const payload = isRecord(rawPayload) ? { ...rawPayload } : {};
  const fields = Array.isArray(payload.fields) ? uniqueStrings(payload.fields) : [];
  const typedCustomFields = Array.isArray(payload.typed_custom_fields) ? uniqueStrings(payload.typed_custom_fields) : [];

  return {
    ...APOLLO_DEFAULT_PEOPLE_SEARCH_PAYLOAD,
    ...payload,
    page,
    per_page: typeof payload.per_page === 'number' ? payload.per_page : 30,
    recommendation_config_id: typeof payload.recommendation_config_id === 'string'
      ? payload.recommendation_config_id
      : 'score',
    sort_ascending: typeof payload.sort_ascending === 'boolean' ? payload.sort_ascending : false,
    sort_by_field: typeof payload.sort_by_field === 'string'
      ? payload.sort_by_field
      : 'recommendations_score',
    display_mode: typeof payload.display_mode === 'string' ? payload.display_mode : 'explorer_mode',
    open_factor_names: Array.isArray(payload.open_factor_names) ? payload.open_factor_names : [],
    num_fetch_result: typeof payload.num_fetch_result === 'number' ? payload.num_fetch_result : 1,
    context: typeof payload.context === 'string' ? payload.context : 'people-index-page',
    show_suggestions: typeof payload.show_suggestions === 'boolean' ? payload.show_suggestions : false,
    include_account_engagement_stats: typeof payload.include_account_engagement_stats === 'boolean'
      ? payload.include_account_engagement_stats
      : false,
    include_contact_engagement_stats: typeof payload.include_contact_engagement_stats === 'boolean'
      ? payload.include_contact_engagement_stats
      : false,
    finder_version: typeof payload.finder_version === 'number' ? payload.finder_version : 2,
    fields: fields.length > 0 ? uniqueStrings([...APOLLO_PEOPLE_SEARCH_FIELDS, ...fields]) : [...APOLLO_PEOPLE_SEARCH_FIELDS],
    typed_custom_fields: typedCustomFields.length > 0
      ? typedCustomFields
      : deriveTypedCustomFields(fields),
    search_session_id: randomUUID(),
    ui_finder_random_seed: randomAlphaNumeric(11),
    cacheKey: Date.now(),
  };
}

export function buildReplayHeaders(
  headers: Record<string, string>,
  auth: { csrfToken: string; cookies: string },
): Record<string, string> {
  const replayHeaders: Record<string, string> = {
    accept: headers.accept || '*/*',
    'accept-language': headers['accept-language'] || 'en-US,en;q=0.9',
    'content-type': headers['content-type'] || 'application/json',
    cookie: auth.cookies,
    'x-accept-language': headers['x-accept-language'] || 'en',
    'x-csrf-token': auth.csrfToken || headers['x-csrf-token'] || '',
    'x-referer-host': headers['x-referer-host'] || 'app.apollo.io',
    'x-referer-path': headers['x-referer-path'] || '/people',
  };

  for (const headerName of ['baggage', 'sentry-trace', 'x-cf-widget-type']) {
    const value = headers[headerName];
    if (value) {
      replayHeaders[headerName] = value;
    }
  }

  return replayHeaders;
}

async function captureDebugScreenshot(page: Page, jobId: string, suffix: string): Promise<string | null> {
  try {
    const logsDir = path.resolve('logs');
    await mkdir(logsDir, { recursive: true });
    const filePath = path.join(logsDir, `${jobId}-${suffix}-${Date.now()}.png`);
    const screenshot = await safePageScreenshot(page, { path: filePath, fullPage: true });
    if (!screenshot) {
      return null;
    }
    return filePath;
  } catch (err) {
    logger.warn({ jobId, err: err instanceof Error ? err.message : String(err) }, 'Failed to capture debug screenshot');
    return null;
  }
}

async function navigateToTarget(page: Page, jobId: string, targetUrl: string): Promise<void> {
  const target = new URL(targetUrl);
  const targetHash = target.hash || '#/people';
  const targetHref = target.toString();

  logger.info({ jobId, currentUrl: page.url(), targetHash, targetHref }, 'Navigating Apollo app to people route');

  if (!page.url().includes('app.apollo.io')) {
    throw new Error(`Apollo app context missing after auth: ${page.url()}`);
  }

  if (page.url().includes('/#/login')) {
    throw new Error('Apollo redirected back to login after authentication');
  }

  try {
    await page.goto(targetHref, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
  } catch (err) {
    logger.warn(
      { jobId, currentUrl: page.url(), targetHref, err: err instanceof Error ? err.message : String(err) },
      'Direct Apollo route navigation failed, falling back to hash mutation',
    );

    await page.evaluate(mutateHashScript, targetHash);
  }

  await page.waitForFunction(
    "window.location.hash.startsWith('#/people') || window.location.pathname === '/people'",
    undefined,
    { timeout: 60_000 },
  );

  await page.waitForLoadState('networkidle', { timeout: APOLLO_SETTLE_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  logger.info({ jobId, currentUrl: page.url(), targetHash, targetHref }, 'Apollo people route requested');
}

function isSearchUrl(targetUrl: string): boolean {
  return targetUrl.includes('?') || targetUrl.includes('search%5B') || targetUrl.includes('search[');
}

async function preparePeopleRouteForSearch(page: Page, jobId: string): Promise<void> {
  await navigateToTarget(page, jobId, APOLLO_PEOPLE_BASE_URL);
  logger.info({ jobId, delayMs: PRE_SEARCH_HUMAN_DELAY_MS }, 'Running pre-search human activity on Apollo people page');

  const stepDelayMs = Math.floor(PRE_SEARCH_HUMAN_DELAY_MS / 5);
  const actions = [
    () => page.mouse.move(420, 170, { steps: 18 }),
    () => page.mouse.move(980, 260, { steps: 24 }),
    () => safePageEvaluate(page, () => { window.scrollTo({ top: 320, behavior: 'instant' }); }),
    () => safePageEvaluate(page, () => {
      const target = document.querySelector('button, a, [role="button"]') as HTMLElement | null;
      target?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    }),
    () => safePageEvaluate(page, () => { window.scrollTo({ top: 0, behavior: 'instant' }); }),
  ];

  for (const action of actions) {
    await action().catch(() => undefined);
    await page.waitForTimeout(stepDelayMs).catch(() => undefined);
  }
}

async function materializePageLevelChallenge(
  page: Page,
  jobId: string,
  challengeType: string | null,
): Promise<ChallengeDetection | null> {
  for (let attempt = 1; attempt <= INLINE_CHALLENGE_ATTEMPTS; attempt += 1) {
    logger.warn(
      { jobId, challengeType, attempt, maxAttempts: INLINE_CHALLENGE_ATTEMPTS },
      'API challenge detected; retrying via top-level people route to materialize page-level challenge',
    );
    await navigateToTarget(page, jobId, APOLLO_PEOPLE_BASE_URL);
    await page.waitForTimeout(3_000).catch(() => undefined);
    const detection = await detectChallenge(page);
    if (detection.type !== null) {
      return detection;
    }
  }

  return null;
}

async function waitForApolloPeoplePayload(page: Page, jobId: string): Promise<ApolloPeopleApiResponse> {
  const deadline = Date.now() + PEOPLE_RESPONSE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const response = await page.waitForResponse(
      candidate => {
        if (candidate.request().method() !== 'POST' || !candidate.url().includes('/api/v1/mixed_people/search')) {
          return false;
        }

        const requestPayload = parseRequestJson(candidate.request());
        const responsePath = extractResponsePath(candidate.url());
        return isCanonicalPeopleSearchCapture(responsePath, requestPayload);
      },
      { timeout: remainingMs },
    );

    const request = response.request();
    const responsePath = extractResponsePath(response.url());
    const requestCapture: ApolloRequestCapture = {
      headers: await readRequestHeaders(request),
      method: request.method(),
      postDataJson: parseRequestJson(request),
      requestUrl: request.url(),
      responsePath,
      displayMode: getApolloDisplayMode(parseRequestJson(request)),
    };

    logger.info(
      {
        jobId,
        responsePath,
        displayMode: requestCapture.displayMode,
        canonicalPeopleSearch: isCanonicalPeopleSearchCapture(responsePath, requestCapture.postDataJson),
      },
      'Captured Apollo people search candidate',
    );

    const contentType = response.headers()['content-type'] ?? '';
    const bodyText = await response.text().catch(() => '');
    const { challengeType, challengeSitekey } = detectChallengeTypeFromText(`${contentType}\n${bodyText}`);
    const responseMeta = buildResponseMeta(
      response.url(),
      response.status(),
      contentType,
      bodyText,
      challengeSitekey,
      challengeType ? 'api_response' : null,
    );

    if (!contentType.includes('application/json')) {
      logger.warn(
        {
          jobId,
          ...responseMeta,
          challengeType,
        },
        'Apollo people response is non-JSON',
      );

      if (challengeType) {
        throw new ApolloResponseError(
          `Apollo people response looks like ${challengeType} challenge`,
          responseMeta,
          ['Non-JSON response returned for /api/v1/mixed_people/search'],
          challengeType,
        );
      }

      throw new ApolloResponseError(
        'Apollo people response is non-JSON',
        responseMeta,
        ['Non-JSON response returned for /api/v1/mixed_people/search'],
      );
    }

    let payload: unknown;
    try {
      const rawResponse = JSON.parse(bodyText) as unknown;
      console.log('raw keys:', Object.keys((rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse))
        ? rawResponse as Record<string, unknown>
        : {}));
      payload = rawResponse;
    } catch (err) {
      logger.warn(
        {
          jobId,
          ...responseMeta,
          challengeType,
          err: err instanceof Error ? err.message : String(err),
        },
        'Apollo people response contains invalid JSON',
      );

      throw new ApolloResponseError(
        challengeType
          ? `Apollo people response contains invalid JSON and looks like ${challengeType} challenge`
          : 'Apollo people response contains invalid JSON',
        responseMeta,
        ['Invalid JSON returned for /api/v1/mixed_people/search'],
        challengeType,
      );
    }

    return {
      payload,
      responseMeta,
    };
  }

  throw new Error(`Apollo people search response not observed within ${PEOPLE_RESPONSE_TIMEOUT_MS}ms`);
}

export async function createCrawler(deps: CrawlerDeps): Promise<ManagedCrawler> {
  const { jobId, launchAttempt = 1, onChallengeDetected, onPeopleResponse } = deps;
  let browserContext: BrowserContext | null = null;
  let terminalError: Error | null = null;
  return {
    run: async requests => {
      try {
        const firstRequest = requests[0];
        if (!firstRequest) {
          throw new Error('Crawler run() requires at least one request');
        }

        const targetUrl = typeof firstRequest.userData?.targetUrl === 'string'
          ? firstRequest.userData.targetUrl
          : String(firstRequest.url);

        browserContext = await launchApolloContext(jobId);
        const page = browserContext.pages()[0] ?? await browserContext.newPage();

        attachPageDiagnostics(page, jobId);
        page.setDefaultNavigationTimeout(120_000);
        page.setDefaultTimeout(120_000);
        await configureApolloPage(page);
        await AuthManager.ensureAuthenticated(page, jobId);
        await navigateToTarget(page, jobId, APOLLO_PEOPLE_BASE_URL);
        const warmup = await warmupApolloSession(page, jobId);
        const sessionPreflight = await runApolloSessionPreflight(page);
        logger.info({ jobId, launchAttempt, warmup, sessionPreflight }, 'Apollo session preflight completed');
        if (sessionPreflight.blockers.length > 0) {
          throw new SessionTrustError(
            `Apollo session is not stable enough for people search: ${sessionPreflight.blockers.join('; ')}`,
            sessionPreflight.blockers,
          );
        }

        let inlineChallengeAttempts = 0;
        let warmupCompletedAt = Date.now();
        if (isSearchUrl(targetUrl)) {
          await preparePeopleRouteForSearch(page, jobId);
          warmupCompletedAt = Date.now();
        }

        while (true) {
          const peopleResponsePromise: Promise<ApolloPeopleApiResult> = waitForApolloPeoplePayload(page, jobId)
            .then<ApolloPeopleApiResult>(value => ({ ok: true, value }))
            .catch<ApolloPeopleApiResult>(error => ({ ok: false, error }));
          logger.info(
            { jobId, launchAttempt, targetUrl, msSinceWarmupCompleted: Date.now() - warmupCompletedAt },
            'Triggering Apollo people search',
          );
          await navigateToTarget(page, jobId, targetUrl);

          const domDetection = await detectChallenge(page);
          if (domDetection.type !== null) {
            const result = onChallengeDetected?.(domDetection, targetUrl, page);
            if (result instanceof Promise) {
              await result;
            }

            if (
              (domDetection.type === 'recaptcha' || domDetection.type === 'turnstile')
              && inlineChallengeAttempts < INLINE_CHALLENGE_ATTEMPTS
            ) {
              inlineChallengeAttempts += 1;
              await page.waitForTimeout(3_000);
              continue;
            }
          }

          if (!onPeopleResponse) {
            return { requestsFinished: 1, requestsFailed: 0 };
          }

          try {
            const peopleResponseResult = await peopleResponsePromise;
            if (!peopleResponseResult.ok) {
              throw peopleResponseResult.error;
            }

            await onPeopleResponse(
              peopleResponseResult.value.payload,
              peopleResponseResult.value.responseMeta,
              page,
              targetUrl,
            );

            return { requestsFinished: 1, requestsFailed: 0 };
          } catch (err) {
            if (
              err instanceof ApolloResponseError
              && (err.challengeType === 'turnstile' || err.challengeType === 'recaptcha' || err.challengeType === 'cloudflare')
              && inlineChallengeAttempts < INLINE_CHALLENGE_ATTEMPTS
            ) {
              inlineChallengeAttempts += 1;
              if (err.challengeSource === 'api_response') {
                const pageLevelDetection = await materializePageLevelChallenge(page, jobId, err.challengeType);
                if (pageLevelDetection) {
                  const result = onChallengeDetected?.(
                    {
                      ...pageLevelDetection,
                      sitekey: pageLevelDetection.sitekey ?? err.responseMeta.challengeSitekey ?? null,
                      source: 'page_dom',
                    },
                    safePageUrl(page) ?? err.responseMeta.responseUrl,
                    page,
                  );
                  if (result instanceof Promise) {
                    await result;
                  }
                  await page.waitForTimeout(3_000);
                  continue;
                }
              } else {
                const responseDetection: ChallengeDetection = {
                  type: err.challengeType,
                  sitekey: err.responseMeta.challengeSitekey ?? null,
                  message: `Challenge detected in Apollo API response: ${err.challengeType}`,
                  source: 'api_response',
                };
                const result = onChallengeDetected?.(responseDetection, err.responseMeta.responseUrl, page);
                if (result instanceof Promise) {
                  await result;
                }
                await page.waitForTimeout(3_000);
                continue;
              }
            }

            const screenshotPath = await captureDebugScreenshot(page, jobId, 'people-response-timeout');
            logger.error(
              {
                jobId,
                currentUrl: safePageUrl(page),
                targetUrl,
                screenshotPath,
                err: err instanceof Error ? err.message : String(err),
              },
              'Failed while waiting for Apollo people search response',
            );
            throw err;
          }
        }
      } catch (err) {
        terminalError = err instanceof Error ? err : new Error(String(err));
        return { requestsFinished: 0, requestsFailed: 1 };
      }
    },
    teardown: async () => {
      if (!browserContext) {
        return;
      }

      await browserContext.close();
      browserContext = null;
    },
    consumeTerminalError: () => {
      const currentError = terminalError;
      terminalError = null;
      return currentError;
    },
  };
}
