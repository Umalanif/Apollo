/**
 * Direct navigation test with hash URL
 */
import { chromium } from 'playwright';
import { getEnv } from './src/env/schema';
import { PrismaClient } from '@prisma/client';
import { saveLead } from './src/db/db.service';
import { scrapeLeadsFromPage } from './src/leads-scraper';

const prisma = new PrismaClient();

async function main() {
  const env = getEnv();
  const jobId = 'phase16-test-' + Date.now();

  console.log('=== Phase 16.3 Hash Navigation Test ===\n');

  // Load auth.json first
  const fs = await import('fs');
  const authPath = 'storage/auth.json';

  if (!fs.existsSync(authPath)) {
    console.log('ERROR: auth.json not found.');
    process.exit(1);
  }

  const authState = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
  console.log('Loaded auth.json with', authState.cookies?.length || 0, 'cookies');

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

  // Create context with auth cookies from storage/auth.json
  const context = await browser.newContext({
    proxy: {
      server: `http://${env.PROXY_HOST}:10000`,
      username: env.PROXY_USERNAME,
      password: env.PROXY_PASSWORD,
    },
  });

  // Add Apollo cookies from auth.json
  if (authState.cookies) {
    const apolloCookies = authState.cookies.filter(
      (c: { domain?: string }) => c.domain && c.domain.includes('apollo.io')
    );
    console.log('Adding', apolloCookies.length, 'Apollo cookies to context');
    await context.addCookies(apolloCookies);
  }

  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('  [Browser ERROR]:', msg.text().slice(0, 200));
    }
  });

  try {
    // First: navigate to home to initialize the SPA
    console.log('\n--- Phase 1: Load home page ---');
    await page.goto('https://app.apollo.io/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    console.log('Home URL:', page.url());
    console.log('Home title:', await page.title());

    if (page.url().includes('/login')) {
      console.log('[FAIL] Redirected to login from home');
      return;
    }
    console.log('[OK] Home page loaded');

    // Second: set the hash route via JavaScript
    console.log('\n--- Phase 2: Hash navigation ---');
    const hashPath = '/people?search[title]=engineer&search[locations][]=United+States';
    console.log('Setting hash to:', hashPath);

    await page.evaluate((hash: string) => {
      window.location.hash = hash;
    }, hashPath);

    // Wait for hash router to process
    await page.waitForFunction(
      (expectedHash: string) => window.location.hash.startsWith(expectedHash.split('?')[0]),
      hashPath.split('?')[0],
      { timeout: 15000 },
    );

    console.log('URL after hash:', page.url());
    console.log('Title after hash:', await page.title());

    // Wait for the page to stabilize
    await page.waitForTimeout(5000);

    // Check if we're on login
    if (page.url().includes('/login')) {
      console.log('[FAIL] Redirected to login after hash navigation');
      return;
    }
    console.log('[OK] Hash navigation successful');

    // Third: extract leads
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
    console.log('Saved', savedCount, 'leads to database');

    // Verification
    const leadCount = await prisma.lead.count();
    console.log('\n=== Results ===');
    console.log('Total leads in database:', leadCount);
    console.log('auth.json size:', fs.statSync(authPath).size, 'bytes');

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