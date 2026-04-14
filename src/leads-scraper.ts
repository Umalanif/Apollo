import { z } from 'zod';
import type { LeadInput } from './env/schema';
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

export function parseApolloPeopleResponse(jobId: string, raw: unknown): LeadInput[] {
  const parsed = ApolloPeopleResponseSchema.safeParse(raw);

  if (!parsed.success) {
    logger.warn(
      {
        jobId,
        errors: parsed.error.errors.map(error => `${error.path.join('.')}: ${error.message}`),
      },
      'Intercepted Apollo response failed Zod validation',
    );
    return [];
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
