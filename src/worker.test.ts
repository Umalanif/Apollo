import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPeopleSearchUrl } from './worker';

test('buildPeopleSearchUrl includes customer targeting filters in Apollo query params', () => {
  const url = buildPeopleSearchUrl({
    titles: ['Engineer'],
    locations: ['United States'],
    organizationNumEmployeesRanges: ['51,100', '101,200'],
    organizationIndustryTagIds: ['5567cd4e7369643b70010000'],
  });

  const hashQuery = url.split('?')[1] ?? '';
  const params = new URLSearchParams(hashQuery);

  assert.deepEqual(params.getAll('search[person_titles][]'), ['Engineer']);
  assert.deepEqual(params.getAll('search[person_locations][]'), ['United States']);
  assert.deepEqual(params.getAll('search[organization_num_employees_ranges][]'), ['51,100', '101,200']);
  assert.deepEqual(params.getAll('search[organization_industry_tag_ids][]'), ['5567cd4e7369643b70010000']);
});
