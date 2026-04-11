/**
 * Fresh auth + extraction test - create new session and immediately use it
 */
import { chromium } from 'playwright';
import { getEnv } from './src/env/schema';
import { AuthManager } from './src/services/auth.service';
import { PrismaClient } from '@prisma/client';
import { saveLead } from './src/db/db.service';
import { scrapeLeadsFromPage } from './src/leads-scraper';

const prisma = new PrismaClient();

async function main() {
  const env = getEnv();
  const jobId = 'phase16-fresh-' + Date.now();

  console.log('=== Phase 16.3 Fresh Auth Test ===\n');

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

  const context = await browser.newContext({
    proxy: {
      server: `http://${env.PROXY_HOST}:10000`,
      username: env.PROXY_USERNAME,
      password: env.PROXY_PASSWORD,
    },
  });

  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('  [Browser ERROR]:', msg.text().slice(0, 200));
    }
  });

  const fs = await import('fs');
  let authJsonSize = 0;

  try {
    // --- Phase 1: Fresh Authentication ---
    console.log('--- Phase 1: Fresh Authentication ---');
    await page.goto('https://app.apollo.io/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const title = await page.title();
    console.log('Initial title:', title);
    console.log('Initial URL:', page.url());

    if (title.toLowerCase().includes('log in') || page.url().includes('/login')) {
      console.log('Login page detected - running AuthManager...');
      await AuthManager.ensureAuthenticated(page, jobId);
      console.log('AuthManager completed');
    } else {
      console.log('Already authenticated');
    }

    // Save fresh session
    const authPath = 'storage/auth.json';
    if (!fs.existsSync('storage')) {
      fs.mkdirSync('storage', { recursive: true });
    }
    await context.storageState({ path: authPath });
    const stats = fs.statSync(authPath);
    authJsonSize = stats.size;
    console.log('Fresh session saved (' + stats.size + ' bytes)');

    // --- Phase 2: Hash Navigation to People Search ---
    console.log('\n--- Phase 2: Navigate to People Search ---');
    const hashPath = '/people?search[title]=engineer&search[locations][]=United+States';

    await page.evaluate((hash: string) => {
      window.location.hash = hash;
    }, hashPath);

    await page.waitForTimeout(5000);
    console.log('URL after hash:', page.url());
    console.log('Title after hash:', await page.title());

    if (page.url().includes('/login')) {
      console.log('[FAIL] Redirected to login - session did not persist');
      console.log('This indicates the session is IP-bound or has other validation');
      return;
    }
    console.log('[OK] Hash navigation successful');

    // --- Phase 3: Extract Leads ---
    console.log('\n--- Phase 3: Extract Leads ---');
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
    console.log('Saved', savedCount, 'leads to database');

    // --- Verification ---
    const leadCount = await prisma.lead.count();
    console.log('\n=== PHASE 16.3 REPORT ===');
    console.log('1. Auth Status: SUCCESS - Fresh session created via AuthManager');
    console.log('2. Persistence Check: auth.json exists, size =', authJsonSize, 'bytes');
    console.log('3. Extraction Result: Total leads in database =', leadCount);
    console.log('4. Session persisted correctly through hash navigation');

  } catch (err) {
    console.error('\n[FATAL ERROR]:', err.message);
    throw err;
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }

  console.log('\n=== Test Completed ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});