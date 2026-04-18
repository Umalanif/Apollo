import assert from 'node:assert/strict';
import test from 'node:test';
import { LeadSchema, normalizeLinkedInUrl } from './env/schema';

test('normalizeLinkedInUrl upgrades protocol and strips www', () => {
  assert.equal(
    normalizeLinkedInUrl('http://www.linkedin.com/in/laurencefink'),
    'https://linkedin.com/in/laurencefink',
  );
});

test('LeadSchema normalizes LinkedIn URL before validation', () => {
  const lead = LeadSchema.parse({
    linkedInUrl: 'http://www.linkedin.com/in/laurencefink',
    firstName: 'Larry',
    lastName: 'Fink',
  });

  assert.equal(lead.linkedInUrl, 'https://linkedin.com/in/laurencefink');
});
