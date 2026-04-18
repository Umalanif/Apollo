import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveProfileDir } from './browser-launch';
import {
  buildReplayHeaders,
  detectChallengeTypeFromText,
  isCanonicalPeopleSearchCapture,
  normalizePeopleSearchPayload,
} from './crawler';

test('detectChallengeTypeFromText classifies Turnstile HTML as challenge', () => {
  const result = detectChallengeTypeFromText(`
    text/html
    <html><body><div class="cf-turnstile" data-sitekey="site-key"></div></body></html>
  `);

  assert.equal(result.challengeType, 'turnstile');
  assert.equal(result.challengeSitekey, 'site-key');
});

test('detectChallengeTypeFromText classifies generic Cloudflare HTML as challenge', () => {
  const result = detectChallengeTypeFromText(`
    text/html
    <html><body>Checking your browser before accessing Apollo</body></html>
  `);

  assert.equal(result.challengeType, 'cloudflare');
});

test('resolveProfileDir reuses stable browser profile by default', () => {
  const firstJob = resolveProfileDir('apollo-job-1');
  const secondJob = resolveProfileDir('apollo-job-2');

  assert.equal(firstJob, secondJob);
  assert.doesNotMatch(firstJob, /attempt-/);
});

test('isCanonicalPeopleSearchCapture accepts explorer_mode people search and rejects metadata-mode', () => {
  assert.equal(
    isCanonicalPeopleSearchCapture('/api/v1/mixed_people/search', { display_mode: 'explorer_mode' }),
    true,
  );
  assert.equal(
    isCanonicalPeopleSearchCapture('/api/v1/mixed_people/search', { display_mode: 'metadata_mode' }),
    false,
  );
  assert.equal(
    isCanonicalPeopleSearchCapture('/api/v1/mixed_people/search/search_metadata_mode', { display_mode: 'explorer_mode' }),
    false,
  );
  assert.equal(
    isCanonicalPeopleSearchCapture('/api/v1/mixed_people/search', { display_mode: 'count_only_mode' }),
    false,
  );
});

test('normalizePeopleSearchPayload refreshes replay-only identifiers and current page', () => {
  const snapshot = {
    page: 99,
    display_mode: 'explorer_mode',
    search_session_id: 'old-session',
    ui_finder_random_seed: 'old-seed',
    cacheKey: 123,
    person_locations: ['New York'],
    organization_num_employees_ranges: ['51,100', '101,200'],
    organization_industry_tag_ids: ['5567cd4e7369643b70010000'],
  };

  const normalized = normalizePeopleSearchPayload(snapshot, 3);

  assert.equal(normalized.page, 3);
  assert.equal(normalized.display_mode, 'explorer_mode');
  assert.deepEqual(normalized.person_locations, ['New York']);
  assert.deepEqual(normalized.organization_num_employees_ranges, ['51,100', '101,200']);
  assert.deepEqual(normalized.organization_industry_tag_ids, ['5567cd4e7369643b70010000']);
  assert.notEqual(normalized.search_session_id, 'old-session');
  assert.match(String(normalized.search_session_id), /^[0-9a-f-]{36}$/i);
  assert.notEqual(normalized.ui_finder_random_seed, 'old-seed');
  assert.match(String(normalized.ui_finder_random_seed), /^[a-z0-9]{11}$/);
  assert.equal(typeof normalized.cacheKey, 'number');
  assert.notEqual(normalized.cacheKey, 123);
});

test('buildReplayHeaders uses live auth and omits turnstile token', () => {
  const replayHeaders = buildReplayHeaders(
    {
      accept: '*/*',
      'x-csrf-token': 'stale-csrf',
      'x-cf-turnstile-response': 'stale-turnstile',
      baggage: 'trace',
    },
    {
      csrfToken: 'live-csrf',
      cookies: 'a=b; c=d',
    },
  );

  assert.equal(replayHeaders.cookie, 'a=b; c=d');
  assert.equal(replayHeaders['x-csrf-token'], 'live-csrf');
  assert.equal(replayHeaders.baggage, 'trace');
  assert.equal('x-cf-turnstile-response' in replayHeaders, false);
});
