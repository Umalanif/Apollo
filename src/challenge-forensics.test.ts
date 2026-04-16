import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTurnstilePageUrl } from './challenge-forensics';

test('resolveTurnstilePageUrl prefers Cloudflare challenge frame URL', () => {
  const result = resolveTurnstilePageUrl({
    fallbackUrl: 'https://fallback.example',
    topLevelPageUrl: 'https://app.apollo.io/#/people',
    challengeFrameUrl: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov1',
    challengeIframeSrc: 'https://challenges.cloudflare.com/iframe',
  });

  assert.equal(result.pageUrl, 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov1');
  assert.equal(result.source, 'challenge_frame_url');
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
