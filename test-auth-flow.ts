/**
 * Direct AuthManager test with working proxy configuration
 */
import { chromium } from 'playwright';
import { getEnv } from './src/env/schema';
import { AuthManager } from './src/services/auth.service';

async function main() {
  const env = getEnv();

  console.log('=== Apollo Auth Flow Test ===\n');
  console.log('Environment:');
  console.log('  Email:', env.APOLLO_EMAIL?.slice(0, 5) + '***');
  console.log('  Proxy:', env.PROXY_HOST);
  console.log('  2Captcha configured:', !!env.TWO_CAPTCHA_API_KEY);

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

  // Use explicit credentials format for proxy
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

  try {
    console.log('\n--- Phase 1: Navigate to Apollo ---');
    await page.goto('https://app.apollo.io/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const title = await page.title();
    console.log('Page title:', title);
    console.log('Current URL:', page.url());

    // Check if on login page
    if (title.toLowerCase().includes('log in') || page.url().includes('/login')) {
      console.log('\n--- Phase 2: Login Required - Running AuthManager ---');
      await AuthManager.ensureAuthenticated(page, 'test-job-direct');
      console.log('AuthManager.ensureAuthenticated completed');
    } else {
      console.log('\n--- Already authenticated ---');
    }

    // Verify we're on the dashboard
    const finalTitle = await page.title();
    const finalUrl = page.url();
    console.log('\n--- Final State ---');
    console.log('Title:', finalTitle);
    console.log('URL:', finalUrl);

    // Save storage state
    console.log('\n--- Phase 3: Save Session ---');
    const fs = await import('fs');
    const authPath = 'storage/auth.json';

    // Ensure storage directory exists
    if (!fs.existsSync('storage')) {
      fs.mkdirSync('storage', { recursive: true });
    }

    await context.storageState({ path: authPath });
    const stats = fs.statSync(authPath);
    console.log('Session saved to:', authPath);
    console.log('File size:', stats.size, 'bytes');

    // Check if login page is no longer shown
    if (finalTitle.toLowerCase().includes('log in')) {
      console.log('\n[FAIL] Still on login page after auth');
    } else {
      console.log('\n[PASS] Successfully reached dashboard');
    }

  } catch (err) {
    console.error('\n[FATAL ERROR]:', err.message);
    throw err;
  } finally {
    await browser.close();
  }

  console.log('\n=== Test Completed ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});