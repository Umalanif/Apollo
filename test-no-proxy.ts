/**
 * Test without proxy - verify extraction works without proxy
 */
import { chromium } from 'playwright';
import { getEnv } from './src/env/schema';
import { AuthManager } from './src/services/auth.service';
import { PrismaClient } from '@prisma/client';
import { saveLead } from './src/db/db.service';
import { scrapeLeadsFromPage } from './src/leads-scraper';

const prisma = new PrismaClient();

async function main() {
  const jobId = 'phase16-noproxy-' + Date.now();

  console.log('=== Phase 16.3 NO PROXY Test ===\n');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
    ],
  });

  // NO PROXY - direct connection
  const context = await browser.newContext();

  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('  [Browser ERROR]:', msg.text().slice(0, 200));
    }
  });

  const fs = await import('fs');
  let authJsonSize = 0;

  try {
    console.log('--- Phase 1: Authentication (no proxy) ---');
    await page.goto('https://app.apollo.io/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const url = page.url();
    console.log('URL:', url);

    if (url.includes('/login')) {
      console.log('Login page - performing auth...');
      await AuthManager.ensureAuthenticated(page, jobId);
    } else {
      console.log('Already on main page');
    }

    const authPath = 'storage/auth.json';
    await context.storageState({ path: authPath });
    authJsonSize = fs.statSync(authPath).size;
    console.log('Session saved (' + authJsonSize + ' bytes)');

    console.log('\n--- Phase 2: Navigate to people search ---');
    await page.goto('https://app.apollo.io/#/people?search[title]=engineer&search[locations][]=United+States',
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);

    console.log('URL:', page.url());
    console.log('Title:', await page.title());

    if (page.url().includes('/login')) {
      console.log('[FAIL] Redirected to login');
      return;
    }

    console.log('\n--- Phase 3: Extract leads ---');
    const rawLeads = await scrapeLeadsFromPage(page, jobId);
    console.log('Found', rawLeads.length, 'raw leads');

    let savedCount = 0;
    for (const raw of rawLeads) {
      try {
        await saveLead(jobId, raw);
        savedCount++;
      } catch (err) {
        if (err instanceof Error && !err.message.includes('Invalid lead data')) {
          console.log('  Save error:', err.message);
        }
      }
    }
    console.log('Saved', savedCount, 'leads');

    const leadCount = await prisma.lead.count();
    console.log('\n=== RESULTS ===');
    console.log('Leads in DB:', leadCount);
    console.log('Auth size:', authJsonSize, 'bytes');

  } catch (err) {
    console.error('\n[FATAL ERROR]:', err.message);
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});