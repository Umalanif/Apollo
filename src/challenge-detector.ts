import type { Page } from 'playwright';
import { detectChallengeChecksScript } from './browser-context';
import { logger } from './logger';

export type ChallengeType =
  | 'cloudflare'
  | 'turnstile'
  | 'datadome'
  | 'recaptcha'
  | 'generic_block'
  | null;

export interface ChallengeDetection {
  type: ChallengeType;
  sitekey: string | null;
  message: string;
}

export async function detectChallenge(page: Page): Promise<ChallengeDetection> {
  const checks = await page.evaluate(detectChallengeChecksScript);

  const { results, sitekey } = checks;
  const priority: ChallengeType[] = ['turnstile', 'cloudflare', 'datadome', 'recaptcha', 'generic_block'];

  let detectedType: ChallengeType = null;
  for (const candidate of priority) {
    if (candidate !== null && results.includes(candidate)) {
      detectedType = candidate;
      break;
    }
  }

  if (!detectedType) {
    return { type: null, sitekey: null, message: 'No challenge detected' };
  }

  const messages: Record<NonNullable<ChallengeType>, string> = {
    turnstile: sitekey
      ? `Cloudflare Turnstile detected (sitekey: ${sitekey})`
      : 'Cloudflare Turnstile detected (no sitekey found)',
    cloudflare: 'Cloudflare challenge / browser verification detected',
    datadome: 'DataDome CAPTCHA challenge detected',
    recaptcha: sitekey
      ? `Google reCAPTCHA challenge detected (sitekey: ${sitekey})`
      : 'Google reCAPTCHA challenge detected (no sitekey found)',
    generic_block: 'Generic block / IP ban / rate-limit page detected',
  };

  logger.debug(
    {
      type: detectedType,
      sitekey,
      markers: [...new Set(results)],
    },
    `[Challenge] ${messages[detectedType]}`,
  );

  return { type: detectedType, sitekey, message: messages[detectedType] };
}
