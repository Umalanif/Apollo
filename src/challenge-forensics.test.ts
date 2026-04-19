import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePostSolveOutcome, resolveTurnstilePageUrl } from './challenge-forensics';

test('resolveTurnstilePageUrl always prefers top-level Apollo page URL when available', () => {
  const result = resolveTurnstilePageUrl({
    fallbackUrl: 'https://fallback.example',
    topLevelPageUrl: 'https://app.apollo.io/#/people',
    challengeFrameUrl: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov1',
    challengeIframeSrc: 'https://challenges.cloudflare.com/iframe',
  });

  assert.equal(result.pageUrl, 'https://app.apollo.io/#/people');
  assert.equal(result.source, 'top_level_page_url');
});

test('resolveTurnstilePageUrl falls back to top-level Apollo page for page-rendered challenges', () => {
  const result = resolveTurnstilePageUrl({
    fallbackUrl: 'https://fallback.example',
    topLevelPageUrl: 'https://app.apollo.io/#/people?search%5Bkeywords%5D%5B%5D=cto',
    challengeFrameUrl: null,
    challengeIframeSrc: null,
  });

  assert.equal(result.pageUrl, 'https://app.apollo.io/#/people?search%5Bkeywords%5D%5B%5D=cto');
  assert.equal(result.source, 'top_level_page_url');
});

test('resolveTurnstilePageUrl uses fallback when no better signal exists', () => {
  const result = resolveTurnstilePageUrl({
    fallbackUrl: 'https://api.example/internal-trigger',
    topLevelPageUrl: '',
    challengeFrameUrl: null,
    challengeIframeSrc: null,
  });

  assert.equal(result.pageUrl, 'https://api.example/internal-trigger');
  assert.equal(result.source, 'fallback_url');
});

test('derivePostSolveOutcome prioritizes Turnstile render failure', () => {
  const result = derivePostSolveOutcome({
    hasVerificationFailedText: false,
    hasTurnstile: true,
    hasCloudflare: false,
    currentPageUrl: 'https://app.apollo.io/#/people',
    turnstileRenderErrorCode: '600010',
    patChallengeFailed: false,
    apolloCookieCount: 4,
    cloudflareCookieNames: ['__cf_bm'],
  }, 'after-solve');

  assert.equal(result, 'turnstile_render_failed');
});

test('derivePostSolveOutcome classifies PAT 401 separately', () => {
  const result = derivePostSolveOutcome({
    hasVerificationFailedText: false,
    hasTurnstile: true,
    hasCloudflare: true,
    currentPageUrl: 'https://app.apollo.io/#/people',
    turnstileRenderErrorCode: null,
    patChallengeFailed: true,
    apolloCookieCount: 4,
    cloudflareCookieNames: ['__cf_bm'],
  }, 'after-solve');

  assert.equal(result, 'pat_401');
});

test('derivePostSolveOutcome detects unchanged cookie state when challenge persists', () => {
  const result = derivePostSolveOutcome({
    hasVerificationFailedText: false,
    hasTurnstile: true,
    hasCloudflare: false,
    currentPageUrl: 'https://app.apollo.io/#/people',
    turnstileRenderErrorCode: null,
    patChallengeFailed: false,
    apolloCookieCount: 4,
    cloudflareCookieNames: ['__cf_bm'],
  }, 'after-solve', {
    apolloCookieCount: 4,
    cloudflareCookieNames: ['__cf_bm'],
  });

  assert.equal(result, 'cookies_unchanged');
});
