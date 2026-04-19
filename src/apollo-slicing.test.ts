import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSliceReplayPayload, getApolloPaginationTotals, getSliceLetters, planSlicePages } from './apollo-slicing';

test('getSliceLetters returns A through Z in order', () => {
  assert.deepEqual(getSliceLetters(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
});

test('planSlicePages skips slices with zero total entries', () => {
  assert.deepEqual(planSlicePages(0, 30), []);
});

test('planSlicePages caps broad slices to first three pages', () => {
  assert.deepEqual(planSlicePages(151, 30), [1, 2, 3]);
});

test('planSlicePages expands all implied pages for small slices', () => {
  assert.deepEqual(planSlicePages(61, 30), [1, 2, 3]);
  assert.deepEqual(planSlicePages(150, 30), [1, 2, 3, 4, 5]);
});

test('buildSliceReplayPayload only mutates person_first_names, page, and freshness fields', () => {
  const snapshot = {
    page: 99,
    person_titles: ['Engineer'],
    person_locations: ['United States'],
    organization_num_employees_ranges: ['51,100', '101,200'],
    organization_industry_tag_ids: ['5567cd4e7369643b70010000'],
    search_session_id: 'old-session',
    ui_finder_random_seed: 'old-seed',
    cacheKey: 123,
  };

  const payload = buildSliceReplayPayload(snapshot, 'A', 2);

  assert.equal(payload.page, 2);
  assert.deepEqual(payload.person_first_names, ['A']);
  assert.deepEqual(payload.person_titles, ['Engineer']);
  assert.deepEqual(payload.person_locations, ['United States']);
  assert.deepEqual(payload.organization_num_employees_ranges, ['51,100', '101,200']);
  assert.deepEqual(payload.organization_industry_tag_ids, ['5567cd4e7369643b70010000']);
  assert.notEqual(payload.search_session_id, 'old-session');
  assert.notEqual(payload.ui_finder_random_seed, 'old-seed');
  assert.notEqual(payload.cacheKey, 123);
});

test('getApolloPaginationTotals reads pagination metadata when present', () => {
  assert.deepEqual(
    getApolloPaginationTotals({ pagination: { total_entries: 84, per_page: 30 } }),
    { totalEntries: 84, perPage: 30 },
  );
  assert.deepEqual(
    getApolloPaginationTotals({}, 25),
    { totalEntries: null, perPage: 25 },
  );
});
