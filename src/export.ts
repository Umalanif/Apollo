import type { PrismaClient } from '@prisma/client';
import type { Row } from '@fast-csv/format';
import { mkdir } from 'node:fs/promises';
import { format } from 'node:path';
import ExcelJS from 'exceljs';
import filenamify from 'filenamify';
import { writeToPath } from 'fast-csv';
import { logger } from './logger';

const EXPORT_DIR = './exports';

const COLUMNS = [
  { header: 'ID', key: 'id', width: 36 },
  { header: 'LinkedIn URL', key: 'linkedInUrl', width: 60 },
  { header: 'First Name', key: 'firstName', width: 20 },
  { header: 'Last Name', key: 'lastName', width: 20 },
  { header: 'Title', key: 'title', width: 40 },
  { header: 'Company', key: 'company', width: 30 },
  { header: 'Company URL', key: 'companyUrl', width: 40 },
  { header: 'Location', key: 'location', width: 30 },
  { header: 'Email', key: 'email', width: 40 },
  { header: 'Phone', key: 'phone', width: 20 },
  { header: 'Created At', key: 'createdAt', width: 28 },
  { header: 'Updated At', key: 'updatedAt', width: 28 },
] as const;

function timestamp(): string {
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

async function fetchLeads(prisma: PrismaClient, jobId: string) {
  return prisma.lead.findMany({
    where: { jobId },
    orderBy: { createdAt: 'asc' },
  });
}

async function writeCsv(prisma: PrismaClient, jobId: string, timestampStr: string): Promise<string> {
  const filename = filenamify(`apollo-${jobId}-${timestampStr}.csv`);
  const filePath = format({ dir: EXPORT_DIR, base: filename });

  await mkdir(EXPORT_DIR, { recursive: true });

  const leads = await fetchLeads(prisma, jobId);
  const rows: Row[] = leads.map(lead => ({
    id: lead.id,
    linkedInUrl: lead.linkedInUrl,
    firstName: lead.firstName,
    lastName: lead.lastName,
    title: lead.title ?? '',
    company: lead.company ?? '',
    companyUrl: lead.companyUrl ?? '',
    location: lead.location ?? '',
    email: lead.email ?? '',
    phone: lead.phone ?? '',
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  }));

  await writeToPath(filePath, rows, { headers: true });
  return filePath;
}

async function writeXlsx(prisma: PrismaClient, jobId: string, timestampStr: string): Promise<string> {
  const filename = filenamify(`apollo-${jobId}-${timestampStr}.xlsx`);
  const filePath = format({ dir: EXPORT_DIR, base: filename });

  await mkdir(EXPORT_DIR, { recursive: true });

  const leads = await fetchLeads(prisma, jobId);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Apollo Scraper';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Leads');
  sheet.columns = COLUMNS.map(({ header, key, width }) => ({ header, key, width }));

  for (const lead of leads) {
    sheet.addRow({
      id: lead.id,
      linkedInUrl: lead.linkedInUrl,
      firstName: lead.firstName,
      lastName: lead.lastName,
      title: lead.title ?? '',
      company: lead.company ?? '',
      companyUrl: lead.companyUrl ?? '',
      location: lead.location ?? '',
      email: lead.email ?? '',
      phone: lead.phone ?? '',
      createdAt: lead.createdAt.toISOString(),
      updatedAt: lead.updatedAt.toISOString(),
    });
  }

  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

export async function exportLeads(prisma: PrismaClient, jobId: string): Promise<string[]> {
  const ts = timestamp();
  const paths: string[] = [];

  try {
    paths.push(await writeCsv(prisma, jobId, ts));
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), format: 'csv' }, 'CSV export failed');
  }

  try {
    paths.push(await writeXlsx(prisma, jobId, ts));
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), format: 'xlsx' }, 'XLSX export failed');
  }

  return paths;
}
