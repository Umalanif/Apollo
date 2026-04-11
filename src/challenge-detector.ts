/**
 * Challenge Detector — DOM scanner for anti-bot / CAPTCHA challenges
 *
 * Phase 7.3: Scans the page DOM after load to detect:
 *   - Cloudflare challenge page (cf-browser-verification, cf-spinner, pending-check)
 *   - DataDome CAPTCHA (data-dome CAPTCHA elements, datadome challenge modal)
 *   - reCAPTCHA (g-recaptcha, greCAPTCHA, recaptcha-badge)
 *   - Generic block / IP ban pages
 *
 * Returns the detected challenge type + sitekey (if present) so the caller
 * can decide whether to solve via 2captcha or bail + rotate proxy.
 *
 * Usage:
 *   const challenge = await detectChallenge(page);
 *   if (challenge) { /* handle *\/ }
 */

import type { Page } from 'playwright';
import { logger } from './logger';

// ── Challenge type enum ───────────────────────────────────────────────────────

export type ChallengeType =
  | 'cloudflare'
  | 'datadome'
  | 'recaptcha'
  | 'generic_block'
  | null;

// ── Detection result ───────────────────────────────────────────────────────────

export interface ChallengeDetection {
  type: ChallengeType;
  sitekey: string | null;   // Google reCAPTCHA sitekey if applicable
  message: string;          // Human-readable summary
}

/**
 * Full-page DOM scan for challenge markers.
 * Call this INSIDE the Playwright requestHandler after the page load settles
 * (after waiting for networkidle / domcontentloaded).
 *
 * Priority: Cloudflare > DataDome > reCAPTCHA > generic block.
 * Multiple markers may be present; we return the highest-severity one.
 */
export async function detectChallenge(page: Page): Promise<ChallengeDetection> {
  // ── Run all detection checks in parallel via page.evaluate ──────────────────

  const checks = await page.evaluate(() => {
    const results: string[] = [];
    let sitekey: string | null = null;

    const doc = document;

    // ── Cloudflare challenge markers ─────────────────────────────────────────
    // Cloudflare may show a verification spinner or "Checking your browser" page
    const cfSpinner = doc.querySelector('#cf-spinner, .cf-spinner, #spinner');
    const cfBrowserVerif = doc.querySelector('#cf-browser-verification, .cf-browser-verification');
    const cfPendingCheck = doc.querySelector('#pending-check, .pending-check, #captcha-interstitial');
    const cfChallengModal = doc.querySelector('#challeng-modal, #challenge-modal');
    const cloudflareTitle = doc.title?.toLowerCase();
    const cfRay = doc.cookie.includes('cf_clearance=');
    const cfError = doc.body?.textContent?.toLowerCase().includes('cloudflare');
    const uaChallenge = doc.body?.textContent?.toLowerCase().includes('please check your browser');
    const cfVerifyHuman = doc.body?.textContent?.toLowerCase().includes('verify you are a human');
    const cfAccessDenied = doc.body?.textContent?.toLowerCase().includes('access denied');
    const cfAccessDeniedTitle = doc.title?.toLowerCase().includes('access denied');

    if (cfSpinner || cfBrowserVerif || cfPendingCheck || cfChallengModal || cfRay || cfError || uaChallenge || cfVerifyHuman || cfAccessDenied) {
      results.push('cloudflare');
    }
    if (cloudflareTitle?.includes('cloudflare') || cfAccessDeniedTitle) {
      results.push('cloudflare');
    }

    // ── DataDome challenge markers ───────────────────────────────────────────
    // DataDome injects a CAPTCHA widget inside a modal overlay
    const dataDomeCaptcha = doc.querySelector(
      '[data-dome-captcha], .datadome-captcha, #datadome-captcha, .dd-captcha',
    );
    const dataDomeModal = doc.querySelector(
      '[data-dome-modal], .datadome-modal, #datadome-modal, .datadome-challenge-modal',
    );
    const dataDomeCaptchaContainer = doc.querySelector(
      '#captcha-container, .captcha-container, #hcaptcha-container',
    );
    const dataDomeText =
      doc.body?.textContent?.toLowerCase().includes('datadome') ||
      doc.body?.textContent?.toLowerCase().includes('data domain') ||
      doc.body?.textContent?.toLowerCase().includes('datadome');

    if (dataDomeCaptcha || dataDomeModal || dataDomeCaptchaContainer || dataDomeText) {
      results.push('datadome');
    }

    // ── Google reCAPTCHA markers ─────────────────────────────────────────────
    const recaptchaEl = doc.querySelector('.g-recaptcha, #g-recaptcha, [data-sitekey]');
    const recaptchaBadge = doc.querySelector('.grecaptcha-badge, #grecaptcha-badge, .recaptcha-badge');
    const recaptchaText =
      doc.body?.textContent?.toLowerCase().includes('recaptcha') &&
      doc.body?.textContent?.toLowerCase().includes('challenge');

    // Extract sitekey from g-recaptcha element
    if (recaptchaEl) {
      sitekey = (recaptchaEl as HTMLElement).dataset?.sitekey ?? null;
      if (!sitekey) {
        sitekey = recaptchaEl.getAttribute('data-sitekey');
      }
    }
    if (!sitekey) {
      // Fallback: look for any element with data-sitekey
      const sitekeyEl = doc.querySelector('[data-sitekey]');
      sitekey = sitekeyEl?.getAttribute('data-sitekey') ?? null;
    }

    if (recaptchaEl || recaptchaBadge || recaptchaText) {
      results.push('recaptcha');
    }

    // ── Generic block / IP ban markers ───────────────────────────────────────
    const blockTextPatterns = [
      'access denied',
      'forbidden',
      'ip blocked',
      'blocked your ip',
      'your ip has been blocked',
      'rate limit',
      'too many requests',
      'please wait',
      'unusual traffic',
      'suspicious activity',
    ];
    const bodyText = doc.body?.textContent?.toLowerCase() ?? '';
    for (const pattern of blockTextPatterns) {
      if (bodyText.includes(pattern)) {
        results.push('generic_block');
        break;
      }
    }

    // Check page title for block indicators
    const title = doc.title?.toLowerCase() ?? '';
    if (
      title.includes('access denied') ||
      title.includes('forbidden') ||
      title.includes('blocked')
    ) {
      results.push('generic_block');
    }

    return { results, sitekey };
  });

  const { results, sitekey } = checks;

  // ── Determine highest-priority challenge ─────────────────────────────────────

  // Priority order (most severe first)
  const priority: ChallengeType[] = ['cloudflare', 'datadome', 'recaptcha', 'generic_block'];

  let detectedType: ChallengeType = null;
  for (const p of priority) {
    if (p !== null && results.includes(p)) {
      detectedType = p;
      break;
    }
  }

  if (!detectedType) {
    return { type: null, sitekey: null, message: 'No challenge detected' };
  }

  // ── Build human-readable message ─────────────────────────────────────────────

  const messages: Record<NonNullable<ChallengeType>, string> = {
    cloudflare: 'Cloudflare challenge / browser verification detected',
    datadome: 'DataDome CAPTCHA challenge detected',
    recaptcha: sitekey
      ? `Google reCAPTCHA challenge detected (sitekey: ${sitekey})`
      : 'Google reCAPTCHA challenge detected (no sitekey found)',
    generic_block: 'Generic block / IP ban / rate-limit page detected',
  };

  const message = messages[detectedType];

  logger.debug(
    {
      type: detectedType,
      sitekey,
      markers: [...new Set(results)],
    },
    `[Challenge] ${message}`,
  );

  return { type: detectedType, sitekey, message };
}
