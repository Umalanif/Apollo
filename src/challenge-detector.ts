import type { Page } from 'playwright';
import { readManualChallengeStateScript } from './browser-context';
import { logger } from './logger';
import { safePageEvaluate } from './playwright-helpers';

export type ChallengeType =
  | 'cloudflare'
  | 'turnstile'
  | null;

export interface ChallengeDetection {
  type: ChallengeType;
  sitekey: string | null;
  message: string;
  source?: 'page_dom' | 'api_response';
}

export async function detectChallenge(page: Page): Promise<ChallengeDetection> {
  const state = await safePageEvaluate<{
    hasTurnstile: boolean;
    hasCloudflare: boolean;
    currentUrl: string;
  }>(page, readManualChallengeStateScript);
  if (!state) {
    return { type: null, sitekey: null, message: 'Page closed before challenge detection', source: 'page_dom' };
  }

  const detectedType: ChallengeType = state.hasTurnstile
    ? 'turnstile'
    : (state.hasCloudflare ? 'cloudflare' : null);

  if (!detectedType) {
    return { type: null, sitekey: null, message: 'No challenge detected', source: 'page_dom' };
  }

  const messages: Record<NonNullable<ChallengeType>, string> = {
    turnstile: 'Cloudflare Turnstile detected',
    cloudflare: 'Cloudflare challenge / browser verification detected',
  };

  logger.debug(
    {
      currentUrl: state.currentUrl,
      type: detectedType,
    },
    `[Challenge] ${messages[detectedType]}`,
  );

  return { type: detectedType, sitekey: null, message: messages[detectedType], source: 'page_dom' };
}
