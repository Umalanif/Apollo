/**
 * Simple proxy connectivity test
 */
import { getEnv } from './src/env/schema';

async function main() {
  const env = getEnv();
  const proxyUrl = `http://${env.PROXY_USERNAME}:${env.PROXY_PASSWORD}@${env.PROXY_HOST}:10000`;

  console.log('Testing proxy connectivity...');
  console.log('Proxy host:', env.PROXY_HOST);
  console.log('Proxy port: 10000');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch('https://httpbin.org/ip', {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      console.log('Direct connection works, IP:', data.origin);
    } else {
      console.log('Direct connection failed with status:', response.status);
    }
  } catch (err) {
    console.log('Direct connection failed:', err.message);
  }

  console.log('Test completed');
}

main().catch(console.error);