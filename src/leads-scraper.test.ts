import assert from 'node:assert/strict';
import test from 'node:test';
import { ApolloResponseError, QueryTooBroadError, type ApolloResponseMeta } from './errors';
import { assertApolloQueryNotTooBroad, parseApolloPeopleResponse, parseApolloMetadataResponse } from './leads-scraper';

const responseMeta: ApolloResponseMeta = {
  responseUrl: 'https://app.apollo.io/api/v1/mixed_people/search/search_metadata_mode',
  status: 200,
  contentType: 'application/json',
  bodyPreview: '{"pagination":{"page":1}}',
};

test('parseApolloPeopleResponse throws explicit error for metadata-like payload without people', () => {
  assert.throws(
    () => parseApolloPeopleResponse('job-1', { pagination: { page: 1 }, breadcrumbs: [] }, responseMeta),
    (err: unknown) => {
      assert.ok(err instanceof ApolloResponseError);
      assert.match(err.message, /missing "people" key/i);
      assert.match(err.validationErrors.join('\n'), /raw keys: breadcrumbs, pagination/i);
      return true;
    },
  );
});

test('assertApolloQueryNotTooBroad throws QUERY_TOO_BROAD for oversized metadata-only payload', () => {
  const metadata = parseApolloMetadataResponse(
    'job-1',
    {
      pagination: { page: 1, total_entries: 850000 },
      pipeline_total: 900000,
      partial_results_only: true,
    },
    responseMeta,
  );

  assert.throws(
    () => assertApolloQueryNotTooBroad(metadata, responseMeta, 500000),
    (err: unknown) => {
      assert.ok(err instanceof QueryTooBroadError);
      assert.equal(err.code, 'QUERY_TOO_BROAD');
      assert.equal(err.totalEntries, 850000);
      assert.equal(err.pipelineTotal, 900000);
      return true;
    },
  );
});
