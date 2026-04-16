import { z } from 'zod';
import type { LeadInput } from './env/schema';
import { ApolloResponseError, type ApolloResponseMeta } from './errors';
import { logger } from './logger';

const ApolloOrganizationSchema = z.object({
  name: z.string().optional().nullable(),
  website_url: z.string().optional().nullable(),
}).passthrough();

const ApolloPersonSchema = z.object({
  first_name: z.string().optional().nullable(),
  last_name: z.string().optional().nullable(),
  name: z.string().optional().nullable(),
  linkedin_url: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  organization: ApolloOrganizationSchema.optional().nullable(),
}).passthrough();

const ApolloPeopleResponseSchema = z.object({
  people: z.array(ApolloPersonSchema),
}).passthrough();

const ApolloMetadataResponseSchema = z.object({
  pagination: z.object({
    page: z.number().optional(),
    per_page: z.number().optional(),
    total_entries: z.number().optional(),
    total_pages: z.number().optional(),
  }).partial().optional(),
  breadcrumbs: z.array(z.unknown()).optional(),
  pipeline_total: z.number().optional(),
  faceting: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

function buildLocation(person: z.infer<typeof ApolloPersonSchema>): string | undefined {
  const parts = [person.city, person.state, person.country]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);

  return parts.length > 0 ? parts.join(', ') : undefined;
}

function splitName(person: z.infer<typeof ApolloPersonSchema>): { firstName: string; lastName: string } | null {
  const firstName = person.first_name?.trim();
  const lastName = person.last_name?.trim();

  if (firstName) {
    return { firstName, lastName: lastName ?? '' };
  }

  const fullName = person.name?.trim();
  if (!fullName) {
    return null;
  }

  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
  };
}

function detectChallengeType(raw: unknown, responseMeta: ApolloResponseMeta): string | null {
  const serializedRaw = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const normalized = `${responseMeta.contentType}\n${responseMeta.bodyPreview}\n${serializedRaw}`.toLowerCase();

  if (
    normalized.includes('cf-turnstile')
    || normalized.includes('turnstile')
  ) {
    return 'turnstile';
  }

  if (
    normalized.includes('challenges.cloudflare.com')
    || normalized.includes('cloudflare')
    || normalized.includes('verify you are a human')
    || normalized.includes('checking your browser')
  ) {
    return 'cloudflare';
  }

  if (
    normalized.includes('datadome')
    || normalized.includes('captcha-delivery.com')
  ) {
    return 'datadome';
  }

  if (
    normalized.includes('recaptcha')
    || normalized.includes('g-recaptcha')
  ) {
    return 'recaptcha';
  }

  if (
    normalized.includes('access denied')
    || normalized.includes('forbidden')
    || normalized.includes('too many requests')
    || normalized.includes('rate limit')
    || normalized.includes('unusual traffic')
    || normalized.includes('blocked')
  ) {
    return 'generic_block';
  }

  return null;
}

export function parseApolloPeopleResponse(jobId: string, raw: unknown, responseMeta: ApolloResponseMeta): LeadInput[] {
  const parsed = ApolloPeopleResponseSchema.safeParse(raw);

  if (!parsed.success) {
    const validationErrors = parsed.error.errors.map(error => `${error.path.join('.')}: ${error.message}`);
    const challengeType = detectChallengeType(raw, responseMeta);

    logger.warn(
      {
        jobId,
        responseMeta,
        challengeType,
        errors: validationErrors,
      },
      'Intercepted Apollo response failed Zod validation',
    );

    throw new ApolloResponseError(
      challengeType
        ? `Apollo people payload looks like ${challengeType} challenge/block response`
        : 'Apollo people payload failed schema validation',
      responseMeta,
      validationErrors,
      challengeType,
    );
  }

  const leads: LeadInput[] = [];

  for (const person of parsed.data.people) {
    const linkedInUrl = person.linkedin_url?.trim();
    const name = splitName(person);

    if (!linkedInUrl || !name) {
      continue;
    }

    leads.push({
      linkedInUrl,
      firstName: name.firstName,
      lastName: name.lastName,
      title: person.title?.trim() || undefined,
      company: person.organization?.name?.trim() || undefined,
      companyUrl: person.organization?.website_url?.trim() || undefined,
      location: buildLocation(person),
      email: undefined,
      phone: undefined,
    });
  }

  logger.info({ jobId, count: leads.length }, 'Parsed leads from intercepted Apollo response');
  return leads;
}

export function parseApolloMetadataResponse(
  jobId: string,
  raw: unknown,
  responseMeta: ApolloResponseMeta,
): z.infer<typeof ApolloMetadataResponseSchema> {
  const parsed = ApolloMetadataResponseSchema.safeParse(raw);

  if (!parsed.success) {
    const validationErrors = parsed.error.errors.map(error => `${error.path.join('.')}: ${error.message}`);
    const challengeType = detectChallengeType(raw, responseMeta);

    logger.warn(
      {
        jobId,
        responseMeta,
        challengeType,
        errors: validationErrors,
      },
      'Apollo metadata response failed Zod validation',
    );

    throw new ApolloResponseError(
      challengeType
        ? `Apollo metadata payload looks like ${challengeType} challenge/block response`
        : 'Apollo metadata payload failed schema validation',
      responseMeta,
      validationErrors,
      challengeType,
    );
  }

  logger.info(
    {
      jobId,
      page: parsed.data.pagination?.page,
      totalEntries: parsed.data.pagination?.total_entries,
    },
    'Parsed Apollo metadata response',
  );

  return parsed.data;
}
