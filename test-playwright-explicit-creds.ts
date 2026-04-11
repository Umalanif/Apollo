/**
 * Test Playwright with explicit proxy credentials
 */
import { chromium } from 'playwright';
import { getEnv } from './src/env/schema';

async function main() {
  const env = getEnv();

  console.log('Testing Playwright proxy with explicit credentials...');
  console.log('Proxy host:', env.PROXY_HOST);
  console.log('Proxy port: 10000');
  console.log('Username:', env.PROXY_USERNAME);
  console.log('Password:', env.PROXY_PASSWORD.slice(0, 4) + '***');

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

  // Try with explicit username/password
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
      console.log('Browser console ERROR:', msg.text());
    }
  });

  page.on('response', response => {
    console.log('Response:', response.status(), response.url().slice(0, 80));
  });

  try {
    console.log('\nNavigating to http://httpbin.org/ip...');
    await page.goto('http://httpbin.org/ip', { timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('Success! Body:', bodyText);
  } catch (err) {
    console.log('Error:', err.message.slice(0, 300));
  }

  await browser.close();
  console.log('\nTest completed');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});