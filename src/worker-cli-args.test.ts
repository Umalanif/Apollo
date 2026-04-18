import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseWorkerCliArgs } from './worker-cli-args';

test('parseWorkerCliArgs parses valid targeting JSON', () => {
  const result = parseWorkerCliArgs([
    '--job-id',
    'apollo-123',
    '--targeting',
    '{"titles":["Engineer"],"locations":["United States"],"organizationNumEmployeesRanges":["51,100","101,200"],"organizationIndustryTagIds":["5567cd4e7369643b70010000"]}',
  ]);

  assert.deepEqual(result, {
    jobId: 'apollo-123',
    targeting: {
      titles: ['Engineer'],
      locations: ['United States'],
      organizationNumEmployeesRanges: ['51,100', '101,200'],
      organizationIndustryTagIds: ['5567cd4e7369643b70010000'],
    },
  });
});

test('parseWorkerCliArgs rejects missing targeting value', () => {
  assert.throws(
    () => parseWorkerCliArgs(['--targeting']),
    /Missing value after --targeting/,
  );
});

test('parseWorkerCliArgs parses targeting from --targeting-file', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'apollo-targeting-'));
  const targetingPath = join(tempDir, 'targeting.json');
  writeFileSync(targetingPath, '{"titles":["engineer"],"companies":["Acme"]}');

  const result = parseWorkerCliArgs(['--targeting-file', targetingPath]);

  assert.deepEqual(result, {
    jobId: undefined,
    targeting: {
      titles: ['engineer'],
      companies: ['Acme'],
    },
  });
});

test('parseWorkerCliArgs parses targeting from @file shorthand', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'apollo-targeting-'));
  const targetingPath = join(tempDir, 'targeting.json');
  writeFileSync(targetingPath, '{"locations":["New York"]}');

  const result = parseWorkerCliArgs(['--targeting', `@${targetingPath}`]);

  assert.deepEqual(result, {
    jobId: undefined,
    targeting: {
      locations: ['New York'],
    },
  });
});

test('parseWorkerCliArgs rejects invalid targeting JSON', () => {
  assert.throws(
    () => parseWorkerCliArgs(['--targeting', '{bad json}']),
    /Invalid JSON passed to --targeting/,
  );
});

test('parseWorkerCliArgs rejects schema-invalid targeting JSON', () => {
  assert.throws(
    () => parseWorkerCliArgs(['--targeting', '{"titles":"engineer"}']),
    /Invalid --targeting payload/,
  );
});
