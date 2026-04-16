import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { getApolloBrowserConfig } from './browser-config';
import { logger } from './logger';
import { getPlaywrightProxy, getProxyFingerprint } from './proxy';

function resolveProfileDir(jobId: string): string {
  const browserConfig = getApolloBrowserConfig();
  return path.resolve('storage', `${browserConfig.name}-profile`, jobId);
}

export async function launchApolloContext(jobId: string): Promise<BrowserContext> {
  const browserConfig = getApolloBrowserConfig();
  const userDataDir = resolveProfileDir(jobId);
  await mkdir(userDataDir, { recursive: true });
  const launchArgs = [
    `--lang=${browserConfig.locale}`,
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];

  logger.info(
    {
      jobId,
      browser: browserConfig.name,
      browserChannel: browserConfig.channel ?? 'bundled',
      userDataDir,
      proxy: getProxyFingerprint(),
      locale: browserConfig.locale,
      timezoneId: browserConfig.timezoneId ?? null,
    },
    `Launching persistent ${browserConfig.launchLabel} context`,
  );

  return chromium.launchPersistentContext(userDataDir, {
    channel: browserConfig.channel,
    headless: false,
    slowMo: 250,
    proxy: getPlaywrightProxy(),
    ignoreDefaultArgs: ['--enable-automation'],
    args: launchArgs,
    locale: browserConfig.locale,
    timezoneId: browserConfig.timezoneId,
    viewport: { width: 1440, height: 960 },
  });
}
