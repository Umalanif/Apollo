import type { PrismaClient } from '@prisma/client';
import { LeadSchema } from '../env/schema';

export interface SaveLeadResult {
  success: true;
  inserted: boolean;
  data: {
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
  };
}

export async function saveLead(prisma: PrismaClient, jobId: string, raw: unknown): Promise<SaveLeadResult> {
  const parse = LeadSchema.safeParse(raw);
  if (!parse.success) {
    const log = {
      level: 'warn',
      msg: 'Invalid lead data discarded',
      errors: parse.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
      raw,
    };
    // tty output for dev, structured JSON for prod
    if (process.env.NODE_ENV !== 'production') {
      console.warn(JSON.stringify(log, null, 2));
    }
    return Promise.reject(new Error('Invalid lead data'));
  }

  const data = parse.data;
  const existing = await prisma.lead.findFirst({
    where: {
      jobId,
      linkedInUrl: data.linkedInUrl,
    },
  });

  if (existing) {
    const lead = await prisma.lead.update({
      where: { id: existing.id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        title: data.title ?? null,
        company: data.company ?? null,
        companyUrl: data.companyUrl ?? null,
        location: data.location ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
      },
    });

    return { success: true, inserted: false, data: lead };
  }

  const lead = await prisma.lead.create({
    data: {
      jobId,
      linkedInUrl: data.linkedInUrl,
      firstName: data.firstName,
      lastName: data.lastName,
      title: data.title ?? null,
      company: data.company ?? null,
      companyUrl: data.companyUrl ?? null,
      location: data.location ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
    },
  });

  return { success: true, inserted: true, data: lead };
}

export async function countUniqueLeadsForJob(prisma: PrismaClient, jobId: string): Promise<number> {
  return prisma.lead.count({
    where: { jobId },
  });
}
