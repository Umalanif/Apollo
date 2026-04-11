/**
 * Direct Playwright test with proxy - detailed check
 */
import { chromium } from 'playwright';
import { getEnv } from './src/env/schema';

async function main() {
  const env = getEnv();
  const proxyUrl = `http://${env.PROXY_USERNAME}:${env.PROXY_PASSWORD}@${env.PROXY_HOST}:10000`;

  console.log('Starting Playwright with proxy...');

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
      server: proxyUrl,
    },
  });

  const page = await context.newPage();

  // Log all console messages
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('Browser ERROR:', msg.text());
    }
  });

  page.on('pageerror', err => console.log('Page ERROR:', err.message));

  page.on('response', response => {
    if (response.url().includes('httpbin')) {
      console.log('Response from httpbin:', response.status(), response.url());
    }
  });

  try {
    console.log('Navigating to http://httpbin.org/ip with 30s timeout...');
    const response = await page.goto('http://httpbin.org/ip', { timeout: 30000 });
    console.log('Navigation response status:', response?.status());

    await page.waitForLoadState('networkidle', { timeout: 10000 });

    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('Body text:', bodyText);
    console.log('Body length:', bodyText.length);

    // Try to get full content
    const fullContent = await page.content();
    console.log('Full content length:', fullContent.length);
    console.log('Full content preview:', fullContent.slice(0, 500));

  } catch (err) {
    console.log('Navigation error:', err.message);
  }

  // Now try Apollo
  console.log('\n--- Testing Apollo ---');
  try {
    console.log('Navigating to https://app.apollo.io/...');
    const response = await page.goto('https://app.apollo.io/', { timeout: 60000, waitUntil: 'domcontentloaded' });
    console.log('Navigation response status:', response?.status());
    console.log('Final URL:', page.url());
    console.log('Page title:', await page.title());

  } catch (err) {
    console.log('Apollo navigation error:', err.message);
  }

  await browser.close();
  console.log('\nTest completed');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});