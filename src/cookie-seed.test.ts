import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSeedCookie } from './cookie-seed';

test('filterSeedCookie accepts allowlisted Apollo auth cookies', () => {
  const decision = filterSeedCookie({
    domain: 'app.apollo.io',
    name: 'X-CSRF-TOKEN',
    path: '/',
    secure: true,
    value: 'csrf-token',
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.cookie?.name, 'X-CSRF-TOKEN');
});

test('filterSeedCookie rejects Cloudflare cookies by default', () => {
  const decision = filterSeedCookie({
    domain: '.apollo.io',
    name: '__cf_bm',
    path: '/',
    secure: true,
    value: 'cf-token',
  });

  assert.equal(decision.accepted, false);
  assert.match(decision.reason ?? '', /cloudflare cookie excluded/i);
});

test('filterSeedCookie can include Cloudflare cookies when explicitly enabled', () => {
  const decision = filterSeedCookie({
    domain: '.apollo.io',
    name: '__cf_bm',
    path: '/',
    secure: true,
    value: 'cf-token',
  }, true);

  assert.equal(decision.accepted, true);
  assert.equal(decision.cookie?.name, '__cf_bm');
});
