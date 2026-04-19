import type { PrismaClient } from '@prisma/client';
import type { Row } from '@fast-csv/format';
import { mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { format } from 'node:path';
import { once } from 'node:events';
import filenamify from 'filenamify';
import { writeToPath } from 'fast-csv';
import { logger } from './logger';

const EXPORT_DIR = './exports';

export const EXPORT_COLUMN_KEYS = [
  'linkedInUrl',
  'firstName',
  'lastName',
  'title',
  'company',
  'companyUrl',
  'location',
  'email',
] as const;

type ExportColumnKey = (typeof EXPORT_COLUMN_KEYS)[number];
type LeadRecord = Awaited<ReturnType<PrismaClient['lead']['findMany']>>[number];
type ExportRow = Record<ExportColumnKey, string>;

function timestamp(): string {
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

async function fetchLeads(prisma: PrismaClient, jobId: string) {
  return prisma.lead.findMany({
    where: { jobId },
    orderBy: { createdAt: 'asc' },
  });
}

export function buildExportRow(lead: LeadRecord): ExportRow {
  return {
    linkedInUrl: lead.linkedInUrl,
    firstName: lead.firstName,
    lastName: lead.lastName,
    title: lead.title ?? '',
    company: lead.company ?? '',
    companyUrl: lead.companyUrl ?? '',
    location: lead.location ?? '',
    email: lead.email ?? '',
  };
}

async function writeCsv(prisma: PrismaClient, jobId: string, timestampStr: string): Promise<string> {
  const filename = filenamify(`apollo-${jobId}-${timestampStr}.csv`);
  const filePath = format({ dir: EXPORT_DIR, base: filename });

  await mkdir(EXPORT_DIR, { recursive: true });

  const leads = await fetchLeads(prisma, jobId);
  const rows: Row[] = leads.map(buildExportRow);

  await writeToPath(filePath, rows, { headers: [...EXPORT_COLUMN_KEYS] });
  return filePath;
}

export async function readCsvHeaders(filePath: string): Promise<string[]> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let buffer = '';

  stream.on('data', chunk => {
    buffer += chunk;
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex !== -1) {
      stream.destroy();
    }
  });

  await once(stream, 'close');
  const firstLine = buffer.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.split(',').map(header => header.trim()).filter(Boolean);
}

export async function exportLeads(prisma: PrismaClient, jobId: string): Promise<string[]> {
  const ts = timestamp();
  const paths: string[] = [];

  try {
    paths.push(await writeCsv(prisma, jobId, ts));
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), format: 'csv' }, 'CSV export failed');
  }

  return paths;
}
