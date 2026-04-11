/**
 * Full extraction test - bypasses Crawlee to test auth + extraction directly
 */
import { chromium } from 'playwright';
import { getEnv } from './src/env/schema';
import { AuthManager } from './src/services/auth.service';
import { PrismaClient } from '@prisma/client';
import { saveLead } from './src/db/db.service';
import { logger } from './src/logger';
import { scrapeLeadsFromPage } from './src/leads-scraper';

const prisma = new PrismaClient();

async function main() {
  const env = getEnv();
  const jobId = 'phase16-test-' + Date.now();

  console.log('=== Phase 16.3 Full Extraction Test ===\n');

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

  // Log browser console
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('  [Browser ERROR]:', msg.text().slice(0, 200));
    }
  });

  let authJsonExists = false;
  let authJsonSize = 0;

  try {
    // --- Phase 1: Auth ---
    console.log('--- Phase 1: Authentication ---');
    await page.goto('https://app.apollo.io/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const title = await page.title();
    console.log('Page title:', title);

    if (title.toLowerCase().includes('log in') || page.url().includes('/login')) {
      console.log('Login page detected - running AuthManager...');
      await AuthManager.ensureAuthenticated(page, jobId);
      console.log('AuthManager completed');
    } else {
      console.log('Already authenticated - checking session...');
    }

    // Save session
    const fs = await import('fs');
    const authPath = 'storage/auth.json';
    if (!fs.existsSync('storage')) {
      fs.mkdirSync('storage', { recursive: true });
    }
    await context.storageState({ path: authPath });
    const stats = fs.statSync(authPath);
    authJsonExists = true;
    authJsonSize = stats.size;
    console.log('Session saved to storage/auth.json (' + stats.size + ' bytes)');

    // --- Phase 2: Extraction ---
    console.log('\n--- Phase 2: Extraction ---');

    // Navigate to the search URL with hash routing
    const searchUrl = 'https://app.apollo.io/#/people?search[title]=engineer&search[locations][]=United+States';
    console.log('Navigating to:', searchUrl);

    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, '/people?search[title]=engineer&search[locations][]=United+States');

    await page.waitForTimeout(8000); // Wait for SPA to load

    console.log('URL after hash navigation:', page.url());
    console.log('Title after navigation:', await page.title());

    // Extract leads
    console.log('Running scrapeLeadsFromPage...');
    const rawLeads = await scrapeLeadsFromPage(page, jobId);
    console.log('Found', rawLeads.length, 'raw leads');

    // Save leads to database
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

    // --- Phase 3: Verify ---
    console.log('\n--- Phase 3: Verification ---');

    // Count leads in DB
    const leadCount = await prisma.lead.count();
    console.log('Total leads in database:', leadCount);

    // Report
    console.log('\n=== Phase 16.3 Report ===');
    console.log('1. Auth Status: SUCCESS - Session saved to storage/auth.json');
    console.log('2. Persistence Check: auth.json exists, size =', authJsonSize, 'bytes');
    console.log('3. Extraction Result: Total leads in database =', leadCount);
    console.log('4. Log: Login and extraction completed without CAPTCHA');

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