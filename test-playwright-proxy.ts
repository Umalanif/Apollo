/**
 * Direct Playwright test with proxy - isolated test
 */
import { chromium } from 'playwright';
import { getEnv } from './src/env/schema';

async function main() {
  const env = getEnv();
  const proxyUrl = `http://${env.PROXY_USERNAME}:${env.PROXY_PASSWORD}@${env.PROXY_HOST}:10000`;

  console.log('Starting Playwright with proxy...');
  console.log('Proxy:', proxyUrl.replace(/:[^:@]+@/, ':***@'));

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

  // Enable console logging
  page.on('console', msg => console.log('Browser console:', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('Page error:', err.message));

  try {
    console.log('Navigating to http://httpbin.org/ip...');
    await page.goto('http://httpbin.org/ip', { timeout: 30000 });
    const content = await page.content();
    console.log('Page loaded, content length:', content.length);
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('Body:', bodyText);
  } catch (err) {
    console.log('Navigation error:', err.message);
  }

  await browser.close();
  console.log('Test completed');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});