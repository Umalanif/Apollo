import assert from 'node:assert/strict';
import test from 'node:test';
import { countUniqueLeadsForJob, saveLead } from './db/db.service';

interface StoredLead {
  id: string;
  jobId: string;
  linkedInUrl: string;
  firstName: string;
  lastName: string;
  title: string | null;
  company: string | null;
  companyUrl: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function createMockPrisma() {
  const store = new Map<string, StoredLead>();
  let idCounter = 0;

  return {
    store,
    lead: {
      findFirst: async ({ where }: { where: { jobId: string; linkedInUrl: string } }) => {
        const key = `${where.jobId}:${where.linkedInUrl}`;
        return store.get(key) ?? null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Omit<StoredLead, 'id' | 'jobId' | 'linkedInUrl' | 'createdAt' | 'updatedAt'>;
      }) => {
        const existing = [...store.values()].find(lead => lead.id === where.id);
        const now = new Date();

        if (!existing) {
          throw new Error(`Lead ${where.id} not found`);
        }

        const key = `${existing.jobId}:${existing.linkedInUrl}`;
        const updated: StoredLead = {
          ...existing,
          ...data,
          updatedAt: now,
        };
        store.set(key, updated);
        return updated;
      },
      create: async ({
        data,
      }: {
        data: Omit<StoredLead, 'id' | 'createdAt' | 'updatedAt'>;
      }) => {
        const key = `${data.jobId}:${data.linkedInUrl}`;
        const now = new Date();
        const created: StoredLead = {
          id: `lead-${++idCounter}`,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        store.set(key, created);
        return created;
      },
      count: async ({ where }: { where: { jobId: string } }) => {
        return [...store.values()].filter(lead => lead.jobId === where.jobId).length;
      },
    },
  };
}

test('same linkedInUrl can exist in different jobs', async () => {
  const prisma = createMockPrisma();
  const lead = {
    linkedInUrl: 'https://linkedin.com/in/test-person',
    firstName: 'Test',
    lastName: 'Person',
  };

  await saveLead(prisma as never, 'job-1', lead);
  await saveLead(prisma as never, 'job-2', lead);

  assert.equal(await countUniqueLeadsForJob(prisma as never, 'job-1'), 1);
  assert.equal(await countUniqueLeadsForJob(prisma as never, 'job-2'), 1);
  assert.equal(prisma.store.size, 2);
});

test('same linkedInUrl within one job does not increment the unique count twice', async () => {
  const prisma = createMockPrisma();
  const lead = {
    linkedInUrl: 'https://linkedin.com/in/test-person',
    firstName: 'Test',
    lastName: 'Person',
  };

  const first = await saveLead(prisma as never, 'job-1', lead);
  const second = await saveLead(prisma as never, 'job-1', { ...lead, title: 'Engineer' });

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(await countUniqueLeadsForJob(prisma as never, 'job-1'), 1);
});

test('page stop condition can be checked after full page save completes', async () => {
  const prisma = createMockPrisma();
  const page = [
    { linkedInUrl: 'https://linkedin.com/in/test-a', firstName: 'A', lastName: 'One' },
    { linkedInUrl: 'https://linkedin.com/in/test-b', firstName: 'B', lastName: 'Two' },
    { linkedInUrl: 'https://linkedin.com/in/test-a', firstName: 'A', lastName: 'One' },
  ];

  for (const lead of page) {
    await saveLead(prisma as never, 'job-1', lead);
  }

  assert.equal(await countUniqueLeadsForJob(prisma as never, 'job-1'), 2);
});
