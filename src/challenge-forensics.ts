import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { ChallengeDetection } from './challenge-detector';
import type { ApolloBrowserConfig } from './browser-config';
import {
  type AutomationSignals,
  type ManualChallengeState,
  readAutomationSignalsScript,
  readManualChallengeStateScript,
} from './browser-context';
import { logger } from './logger';
import { safePageEvaluate, safePageScreenshot, safePageUrl } from './playwright-helpers';
import { getProxyFingerprint } from './proxy';

export type ChallengeSolveMode = 'manual' | '2captcha';
export type ChallengePhase = 'before-solve' | 'after-solve';
export type PostSolveOutcome =
  | 'challenge_cleared'
  | 'challenge_still_present'
  | 'verification_failed'
  | 'turnstile_render_failed'
  | 'pat_401'
  | 'cookies_unchanged'
  | 'cookies_improved_but_blocked'
  | 'redirected'
  | 'api_still_blocked'
  | 'unknown';

export interface TurnstilePageUrlResolutionInput {
  fallbackUrl: string;
  topLevelPageUrl: string;
  challengeFrameUrl?: string | null;
  challengeIframeSrc?: string | null;
}

export interface TurnstilePageUrlResolution {
  pageUrl: string;
  source: 'challenge_frame_url' | 'challenge_iframe_src' | 'top_level_page_url' | 'fallback_url';
}

export interface ChallengeForensicsRecord {
  jobId: string;
  challengeType: string | null;
  solveMode: ChallengeSolveMode;
  phase: ChallengePhase;
  browser: ApolloBrowserConfig['name'];
  browserLabel: string;
  topLevelPageUrl: string;
  currentPageUrl: string;
  challengeFrameUrl: string | null;
  challengeIframeSrc: string | null;
  resolvedPageUrl: string | null;
  resolvedPageUrlSource: TurnstilePageUrlResolution['source'] | null;
  sitekey: string | null;
  action: string | null;
  data: string | null;
  pagedata: string | null;
  widgetPresent: boolean;
  hasCloudflare: boolean;
  hasTurnstile: boolean;
  apolloCookieCount: number;
  apolloCookieNames: string[];
  cloudflareCookieNames: string[];
  hasCfBm: boolean;
  hasCfClearance: boolean;
  apolloCookieDelta: number | null;
  cloudflareCookieDelta: number | null;
  hasVerificationFailedText: boolean;
  navigatorWebdriver: boolean | null;
  automationGlobals: string[];
  controlledByAutomationBanner: boolean;
  userAgent: string;
  language: string | null;
  languages: string[];
  timezone: string | null;
  turnstileRenderErrorCode: string | null;
  patChallengeFailed: boolean;
  proxyFingerprint: string;
  outcome: PostSolveOutcome;
  screenshotPath: string | null;
  recordedAt: string;
}

interface PageChallengeSnapshot {
  currentPageUrl: string;
  challengeFrameUrl: string | null;
  challengeIframeSrc: string | null;
  hasVerificationFailedText: boolean;
  widgetPresent: boolean;
  hasTurnstile: boolean;
  hasCloudflare: boolean;
  apolloCookieCount: number;
  apolloCookieNames: string[];
  cloudflareCookieNames: string[];
  hasCfBm: boolean;
  hasCfClearance: boolean;
  sitekey: string | null;
  action: string | null;
  data: string | null;
  pagedata: string | null;
  navigatorWebdriver: boolean | null;
  automationGlobals: string[];
  controlledByAutomationBanner: boolean;
  userAgent: string;
  language: string | null;
  languages: string[];
  timezone: string | null;
  turnstileRenderErrorCode: string | null;
  patChallengeFailed: boolean;
}

function isCloudflareChallengeUrl(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const lower = value.toLowerCase();
  return lower.includes('challenges.cloudflare.com') || lower.includes('/cdn-cgi/challenge-platform/');
}

export function resolveTurnstilePageUrl(input: TurnstilePageUrlResolutionInput): TurnstilePageUrlResolution {
  if (input.topLevelPageUrl) {
    return {
      pageUrl: input.topLevelPageUrl,
      source: 'top_level_page_url',
    };
  }

  return {
    pageUrl: input.fallbackUrl,
    source: 'fallback_url',
  };
}

async function captureChallengeScreenshot(page: Page, jobId: string, phase: ChallengePhase): Promise<string | null> {
  try {
    const logsDir = path.resolve('logs');
    await mkdir(logsDir, { recursive: true });
    const filePath = path.join(logsDir, `${jobId}-challenge-${phase}-${Date.now()}.png`);
    const screenshot = await safePageScreenshot(page, { path: filePath, fullPage: true });
    if (!screenshot) {
      return null;
    }
    return filePath;
  } catch (err) {
    logger.warn({ jobId, phase, err: err instanceof Error ? err.message : String(err) }, 'Failed to capture challenge screenshot');
    return null;
  }
}

async function collectPageChallengeSnapshot(page: Page): Promise<PageChallengeSnapshot> {
  const [manualState, automationSignals] = await Promise.all([
    safePageEvaluate<ManualChallengeState>(page, readManualChallengeStateScript),
    safePageEvaluate<AutomationSignals>(page, readAutomationSignalsScript),
  ]);

  const safeManualState = manualState ?? {
    hasTurnstile: false,
    hasCloudflare: false,
    currentUrl: safePageUrl(page) ?? '',
  };
  const safeAutomationSignals = automationSignals ?? {
    navigatorWebdriver: null,
    automationGlobals: [],
    controlledByAutomationBanner: false,
    userAgent: '',
    language: null,
    languages: [],
    timezone: null,
  };

  let challengeFrameUrl: string | null = null;
  if (!page.isClosed()) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) {
        continue;
      }

      const frameUrl = frame.url();
      if (isCloudflareChallengeUrl(frameUrl)) {
        challengeFrameUrl = frameUrl;
        break;
      }
    }
  }

  const challengeIframeSrc = page.isClosed()
    ? null
    : await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="/cdn-cgi/challenge-platform/"]').first()
      .getAttribute('src')
      .catch(() => null);

  const hasVerificationFailedText = await safePageEvaluate<boolean>(page, () => {
    const bodyText = (document.body?.innerText ?? '').toLowerCase();
    return bodyText.includes('verification failed');
  }) ?? false;
  const currentPageUrl = safePageUrl(page) ?? safeManualState.currentUrl;
  const cookies = page.isClosed()
    ? []
    : await page.context().cookies(currentPageUrl.includes('apollo.io') ? currentPageUrl : 'https://app.apollo.io/');
  const apolloCookies = cookies.filter(cookie => cookie.domain === 'apollo.io' || cookie.domain.endsWith('.apollo.io'));
  const apolloCookieNames = [...new Set(apolloCookies.map(cookie => cookie.name))].sort();
  const cloudflareCookieNames = apolloCookieNames.filter(name => name.startsWith('__cf'));
  return {
    currentPageUrl,
    challengeFrameUrl,
    challengeIframeSrc,
    hasVerificationFailedText,
    widgetPresent: Boolean(safeManualState.hasTurnstile || challengeIframeSrc),
    hasTurnstile: safeManualState.hasTurnstile,
    hasCloudflare: safeManualState.hasCloudflare,
    apolloCookieCount: apolloCookies.length,
    apolloCookieNames,
    cloudflareCookieNames,
    hasCfBm: apolloCookieNames.includes('__cf_bm'),
    hasCfClearance: apolloCookieNames.includes('cf_clearance'),
    sitekey: null,
    action: null,
    data: null,
    pagedata: null,
    navigatorWebdriver: safeAutomationSignals.navigatorWebdriver,
    automationGlobals: safeAutomationSignals.automationGlobals,
    controlledByAutomationBanner: safeAutomationSignals.controlledByAutomationBanner,
    userAgent: safeAutomationSignals.userAgent,
    language: safeAutomationSignals.language,
    languages: safeAutomationSignals.languages,
    timezone: safeAutomationSignals.timezone,
    turnstileRenderErrorCode: null,
    patChallengeFailed: false,
  };
}

export function derivePostSolveOutcome(
  snapshot: Pick<
    PageChallengeSnapshot,
    'hasVerificationFailedText'
    | 'hasTurnstile'
    | 'hasCloudflare'
    | 'currentPageUrl'
    | 'turnstileRenderErrorCode'
    | 'patChallengeFailed'
    | 'apolloCookieCount'
    | 'cloudflareCookieNames'
  >,
  phase: ChallengePhase,
  baseline?: Pick<ChallengeForensicsRecord, 'apolloCookieCount' | 'cloudflareCookieNames'> | null,
): PostSolveOutcome {
  if (phase === 'before-solve') {
    return 'unknown';
  }

  if (snapshot.turnstileRenderErrorCode) {
    return 'turnstile_render_failed';
  }

  if (snapshot.patChallengeFailed) {
    return 'pat_401';
  }

  if (snapshot.hasVerificationFailedText) {
    return 'verification_failed';
  }

  if (!snapshot.hasTurnstile && !snapshot.hasCloudflare) {
    return 'challenge_cleared';
  }

  if (snapshot.currentPageUrl && !snapshot.currentPageUrl.includes('app.apollo.io')) {
    return 'redirected';
  }

  if (baseline) {
    if (
      snapshot.apolloCookieCount === baseline.apolloCookieCount
      && snapshot.cloudflareCookieNames.length === baseline.cloudflareCookieNames.length
    ) {
      return 'cookies_unchanged';
    }

    return 'cookies_improved_but_blocked';
  }

  return 'challenge_still_present';
}

async function writeForensicsRecord(jobId: string, record: ChallengeForensicsRecord): Promise<string | null> {
  try {
    const logsDir = path.resolve('logs');
    await mkdir(logsDir, { recursive: true });
    const filePath = path.join(logsDir, `${jobId}-challenge-${record.phase}-${Date.now()}.json`);
    await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return filePath;
  } catch (err) {
    logger.warn({ jobId, phase: record.phase, err: err instanceof Error ? err.message : String(err) }, 'Failed to persist challenge forensics record');
    return null;
  }
}

export async function recordChallengeForensics(params: {
  page: Page;
  jobId: string;
  detection: ChallengeDetection;
  solveMode: ChallengeSolveMode;
  phase: ChallengePhase;
  browserConfig: ApolloBrowserConfig;
  fallbackUrl: string;
  outcome?: PostSolveOutcome;
  baselineRecord?: ChallengeForensicsRecord | null;
}): Promise<ChallengeForensicsRecord> {
  const snapshot = await collectPageChallengeSnapshot(params.page);
  const screenshotPath = await captureChallengeScreenshot(params.page, params.jobId, params.phase);
  const resolution = params.detection.type === 'turnstile'
    ? resolveTurnstilePageUrl({
      fallbackUrl: params.fallbackUrl,
      topLevelPageUrl: snapshot.currentPageUrl,
      challengeFrameUrl: snapshot.challengeFrameUrl,
      challengeIframeSrc: snapshot.challengeIframeSrc,
    })
    : null;

  const record: ChallengeForensicsRecord = {
    jobId: params.jobId,
    challengeType: params.detection.type,
    solveMode: params.solveMode,
    phase: params.phase,
    browser: params.browserConfig.name,
    browserLabel: params.browserConfig.launchLabel,
    topLevelPageUrl: safePageUrl(params.page) ?? '',
    currentPageUrl: snapshot.currentPageUrl,
    challengeFrameUrl: snapshot.challengeFrameUrl,
    challengeIframeSrc: snapshot.challengeIframeSrc,
    resolvedPageUrl: resolution?.pageUrl ?? null,
    resolvedPageUrlSource: resolution?.source ?? null,
    sitekey: params.detection.sitekey ?? snapshot.sitekey,
    action: snapshot.action,
    data: snapshot.data,
    pagedata: snapshot.pagedata,
    widgetPresent: snapshot.widgetPresent,
    hasCloudflare: snapshot.hasCloudflare,
    hasTurnstile: snapshot.hasTurnstile,
    apolloCookieCount: snapshot.apolloCookieCount,
    apolloCookieNames: snapshot.apolloCookieNames,
    cloudflareCookieNames: snapshot.cloudflareCookieNames,
    hasCfBm: snapshot.hasCfBm,
    hasCfClearance: snapshot.hasCfClearance,
    apolloCookieDelta: params.baselineRecord ? snapshot.apolloCookieCount - params.baselineRecord.apolloCookieCount : null,
    cloudflareCookieDelta: params.baselineRecord
      ? snapshot.cloudflareCookieNames.length - params.baselineRecord.cloudflareCookieNames.length
      : null,
    hasVerificationFailedText: snapshot.hasVerificationFailedText,
    navigatorWebdriver: snapshot.navigatorWebdriver,
    automationGlobals: snapshot.automationGlobals,
    controlledByAutomationBanner: snapshot.controlledByAutomationBanner,
    userAgent: snapshot.userAgent,
    language: snapshot.language,
    languages: snapshot.languages,
    timezone: snapshot.timezone,
    turnstileRenderErrorCode: snapshot.turnstileRenderErrorCode,
    patChallengeFailed: snapshot.patChallengeFailed,
    proxyFingerprint: getProxyFingerprint(),
    outcome: params.outcome ?? derivePostSolveOutcome(snapshot, params.phase, params.baselineRecord),
    screenshotPath,
    recordedAt: new Date().toISOString(),
  };

  const recordPath = await writeForensicsRecord(params.jobId, record);
  logger.info(
    {
      jobId: params.jobId,
      phase: params.phase,
      challengeType: record.challengeType,
      solveMode: record.solveMode,
      outcome: record.outcome,
      recordPath,
      screenshotPath,
      resolvedPageUrl: record.resolvedPageUrl,
      resolvedPageUrlSource: record.resolvedPageUrlSource,
      hasCfBm: record.hasCfBm,
      hasCfClearance: record.hasCfClearance,
      apolloCookieDelta: record.apolloCookieDelta,
      cloudflareCookieDelta: record.cloudflareCookieDelta,
      turnstileRenderErrorCode: record.turnstileRenderErrorCode,
      patChallengeFailed: record.patChallengeFailed,
      navigatorWebdriver: record.navigatorWebdriver,
      automationGlobals: record.automationGlobals,
      controlledByAutomationBanner: record.controlledByAutomationBanner,
    },
    'Challenge forensics recorded',
  );

  return record;
}
