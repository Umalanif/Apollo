import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { ChallengeDetection } from './challenge-detector';
import type { ApolloBrowserConfig } from './browser-config';
import {
  readAutomationSignalsScript,
  readManualChallengeStateScript,
  readTurnstileWidgetStateScript,
} from './browser-context';
import { logger } from './logger';
import { getProxyFingerprint } from './proxy';

export type ChallengeSolveMode = 'manual' | '2captcha';
export type ChallengePhase = 'before-solve' | 'after-solve';
export type PostSolveOutcome =
  | 'challenge_cleared'
  | 'challenge_still_present'
  | 'verification_failed'
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
  hasVerificationFailedText: boolean;
  navigatorWebdriver: boolean | null;
  automationGlobals: string[];
  controlledByAutomationBanner: boolean;
  userAgent: string;
  language: string | null;
  languages: string[];
  timezone: string | null;
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
}

function isCloudflareChallengeUrl(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const lower = value.toLowerCase();
  return lower.includes('challenges.cloudflare.com') || lower.includes('/cdn-cgi/challenge-platform/');
}

export function resolveTurnstilePageUrl(input: TurnstilePageUrlResolutionInput): TurnstilePageUrlResolution {
  if (isCloudflareChallengeUrl(input.challengeFrameUrl)) {
    return {
      pageUrl: input.challengeFrameUrl!,
      source: 'challenge_frame_url',
    };
  }

  if (isCloudflareChallengeUrl(input.challengeIframeSrc)) {
    return {
      pageUrl: input.challengeIframeSrc!,
      source: 'challenge_iframe_src',
    };
  }

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
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch (err) {
    logger.warn({ jobId, phase, err: err instanceof Error ? err.message : String(err) }, 'Failed to capture challenge screenshot');
    return null;
  }
}

async function collectPageChallengeSnapshot(page: Page): Promise<PageChallengeSnapshot> {
  const [manualState, widgetState, automationSignals] = await Promise.all([
    page.evaluate(readManualChallengeStateScript),
    page.evaluate(readTurnstileWidgetStateScript),
    page.evaluate(readAutomationSignalsScript),
  ]);

  let challengeFrameUrl: string | null = null;
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

  const challengeIframeSrc = await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="/cdn-cgi/challenge-platform/"]').first()
    .getAttribute('src')
    .catch(() => null);

  const hasVerificationFailedText = await page.evaluate(() => {
    const bodyText = (document.body?.innerText ?? '').toLowerCase();
    return bodyText.includes('verification failed');
  }).catch(() => false);

  return {
    currentPageUrl: page.url(),
    challengeFrameUrl,
    challengeIframeSrc,
    hasVerificationFailedText,
    widgetPresent: Boolean(widgetState.sitekey || manualState.hasTurnstile || challengeIframeSrc),
    hasTurnstile: manualState.hasTurnstile,
    hasCloudflare: manualState.hasCloudflare,
    sitekey: widgetState.sitekey,
    action: widgetState.action,
    data: widgetState.cData,
    pagedata: widgetState.chlPageData,
    navigatorWebdriver: automationSignals.navigatorWebdriver,
    automationGlobals: automationSignals.automationGlobals,
    controlledByAutomationBanner: automationSignals.controlledByAutomationBanner,
    userAgent: automationSignals.userAgent,
    language: automationSignals.language,
    languages: automationSignals.languages,
    timezone: automationSignals.timezone,
  };
}

function derivePostSolveOutcome(snapshot: PageChallengeSnapshot, phase: ChallengePhase): PostSolveOutcome {
  if (phase === 'before-solve') {
    return 'unknown';
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
    topLevelPageUrl: params.page.url(),
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
    hasVerificationFailedText: snapshot.hasVerificationFailedText,
    navigatorWebdriver: snapshot.navigatorWebdriver,
    automationGlobals: snapshot.automationGlobals,
    controlledByAutomationBanner: snapshot.controlledByAutomationBanner,
    userAgent: snapshot.userAgent,
    language: snapshot.language,
    languages: snapshot.languages,
    timezone: snapshot.timezone,
    proxyFingerprint: getProxyFingerprint(),
    outcome: params.outcome ?? derivePostSolveOutcome(snapshot, params.phase),
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
      navigatorWebdriver: record.navigatorWebdriver,
      automationGlobals: record.automationGlobals,
      controlledByAutomationBanner: record.controlledByAutomationBanner,
    },
    'Challenge forensics recorded',
  );

  return record;
}
