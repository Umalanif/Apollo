/**
 * Direct Playwright test with proxy - try different auth format
 */
import { chromium } from 'playwright';
import { getEnv } from './src/env/schema';

async function main() {
  const env = getEnv();

  console.log('Testing different proxy configurations...');

  const configs = [
    {
      name: 'Standard URL format',
      proxy: {
        server: `http://${env.PROXY_USERNAME}:${env.PROXY_PASSWORD}@${env.PROXY_HOST}:10000`,
      }
    },
    {
      name: 'Separate fields',
      proxy: {
        server: `http://${env.PROXY_HOST}:10000`,
        username: env.PROXY_USERNAME,
        password: env.PROXY_PASSWORD,
      }
    }
  ];

  for (const config of configs) {
    console.log(`\nTrying: ${config.name}`);
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

    const context = await browser.newContext(config);

    const page = await context.newPage();
    let error = null;

    try {
      console.log('  Navigating to http://httpbin.org/ip...');
      await page.goto('http://httpbin.org/ip', { timeout: 15000 });
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log('  Success! Body:', bodyText.slice(0, 100));
    } catch (err) {
      error = err.message;
      console.log('  Failed:', err.message.slice(0, 200));
    }

    await browser.close();

    if (!error) {
      console.log('  This configuration works!');
      break;
    }
  }

  console.log('\nTest completed');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});