import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExportRow, exportLeads, EXPORT_COLUMN_KEYS, readCsvHeaders } from './export';

test('buildExportRow keeps exactly the agreed 8-column shape', () => {
  const row = buildExportRow({
    id: 'lead-1',
    jobId: 'job-1',
    linkedInUrl: 'https://linkedin.com/in/test-person',
    firstName: 'Test',
    lastName: 'Person',
    title: 'Engineer',
    company: 'Acme',
    companyUrl: 'https://acme.test',
    location: 'United States',
    email: 'test@example.com',
    phone: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  assert.deepEqual(Object.keys(row), [...EXPORT_COLUMN_KEYS]);
});

test('exportLeads writes one CSV and scopes rows to the requested jobId', async () => {
  let observedJobId: string | null = null;
  const prisma = {
    lead: {
      findMany: async ({ where }: { where: { jobId: string } }) => {
        observedJobId = where.jobId;
        return [
          {
            id: 'lead-1',
            jobId: where.jobId,
            linkedInUrl: 'https://linkedin.com/in/test-person',
            firstName: 'Test',
            lastName: 'Person',
            title: 'Engineer',
            company: 'Acme',
            companyUrl: 'https://acme.test',
            location: 'United States',
            email: 'test@example.com',
            phone: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ];
      },
    },
  };

  const paths = await exportLeads(prisma as never, 'job-export');

  assert.equal(observedJobId, 'job-export');
  assert.equal(paths.length, 1);
  assert.match(paths[0] ?? '', /\.csv$/i);
  assert.deepEqual(await readCsvHeaders(paths[0]!), [...EXPORT_COLUMN_KEYS]);
});
