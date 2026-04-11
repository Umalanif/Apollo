import { PrismaClient } from '@prisma/client';
import { LeadSchema } from '../env/schema';

const prisma = new PrismaClient();

export interface SaveLeadResult {
  success: true;
  data: {
    id: string;
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

export async function saveLead(jobId: string, raw: unknown): Promise<SaveLeadResult> {
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
  const lead = await prisma.lead.upsert({
    where: { linkedInUrl: data.linkedInUrl },
    update: {
      jobId,
      firstName: data.firstName,
      lastName: data.lastName,
      title: data.title ?? null,
      company: data.company ?? null,
      companyUrl: data.companyUrl ?? null,
      location: data.location ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
    },
    create: {
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

  return { success: true, data: lead };
}