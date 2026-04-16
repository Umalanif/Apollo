import { launchApolloContext } from './browser-launch';
import { fetchJsonViaProxy, getProxyFingerprint } from './proxy';

interface IpifyResponse {
  ip: string;
}

const IP_CHECK_URL = 'https://api.ipify.org?format=json';

async function readBrowserIp(): Promise<string> {
  const context = await launchApolloContext(`egress-check-${Date.now()}`);

  try {
    const page = context.pages()[0] ?? await context.newPage();
    const response = await page.goto(IP_CHECK_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    const text = await response?.text();
    const body = JSON.parse(text ?? '{}') as Partial<IpifyResponse>;
    if (!body.ip) {
      throw new Error('Browser IP response did not contain ip');
    }

    return body.ip;
  } finally {
    await context.close();
  }
}

async function readNodeIp(): Promise<string> {
  const body = await fetchJsonViaProxy<IpifyResponse>(IP_CHECK_URL);
  if (!body.ip) {
    throw new Error('Node proxy IP response did not contain ip');
  }

  return body.ip;
}

async function main(): Promise<void> {
  const browserIp = await readBrowserIp();
  const nodeIp = await readNodeIp();
  const twoCaptchaTransportIp = await readNodeIp();

  console.log(`proxy=${getProxyFingerprint()}`);
  console.log(`browser_ip=${browserIp}`);
  console.log(`node_ip=${nodeIp}`);
  console.log(`two_captcha_transport_ip=${twoCaptchaTransportIp}`);

  if (browserIp !== nodeIp || nodeIp !== twoCaptchaTransportIp) {
    throw new Error('Egress IP mismatch detected across browser, node transport, and 2captcha transport');
  }
}

void main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
