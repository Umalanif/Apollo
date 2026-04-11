/**
 * Direct AuthManager test - bypasses Bree worker_data requirement
 * Run: npx tsx test-auth-direct.ts
 */

import { chromium } from 'playwright';
import { getEnv } from './src/env/schema';
import { AuthManager } from './src/services/auth.service';
import { logger } from './src/logger';

async function main() {
  console.log('Starting direct AuthManager test...');

  const env = getEnv();
  console.log('Environment loaded:', {
    email: env.APOLLO_EMAIL?.slice(0, 3) + '***',
    hasPassword: !!env.APOLLO_PASSWORD,
    hasProxy: !!env.PROXY_HOST,
    has2Captcha: !!env.TWO_CAPTCHA_API_KEY,
    database: env.DATABASE_URL,
  });

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
      server: `http://${env.PROXY_USERNAME}:${env.PROXY_PASSWORD}@${env.PROXY_HOST}:10000`,
    },
  });

  const page = await context.newPage();

  try {
    console.log('Navigating to Apollo...');
    await page.goto('https://app.apollo.io/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const title = await page.title();
    console.log('Page title:', title);

    if (title.toLowerCase().includes('log in')) {
      console.log('Login page detected - running AuthManager.ensureAuthenticated...');
      await AuthManager.ensureAuthenticated(page, 'test-job-001');
      console.log('AuthManager completed');
    } else {
      console.log('Already authenticated - checking session...');
    }

    // Check if auth.json was created
    const fs = await import('fs');
    const authPath = 'storage/auth.json';
    if (fs.existsSync(authPath)) {
      const stats = fs.statSync(authPath);
      console.log(`Auth file exists: ${authPath}`);
      console.log(`Size: ${stats.size} bytes`);
      console.log(`Modified: ${stats.mtime}`);
    } else {
      console.log('Auth file NOT found at', authPath);
    }

    console.log('Test completed successfully');
  } catch (error) {
    console.error('Test failed:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});