import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { getApolloBrowserConfig } from './browser-config';
import { bootstrapContextFromCookieSeed } from './cookie-seed';
import { getEnv, getMicrosoftCredentials } from './env/schema';
import { logger } from './logger';
import { getPlaywrightProxy, getProxyFingerprint } from './proxy';

export interface LaunchApolloContextOptions {
  profileId?: string;
}

function sanitizeProfileSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'default';
}

export function resolveStableProfileId(): string {
  const env = getEnv();
  const browserConfig = getApolloBrowserConfig();
  const credentials = getMicrosoftCredentials();

  if (env.APOLLO_PROFILE_KEY_MODE === 'account-proxy-browser' || env.APOLLO_PROFILE_KEY_MODE === undefined) {
    return [
      sanitizeProfileSegment(credentials.email),
      sanitizeProfileSegment(getProxyFingerprint()),
      sanitizeProfileSegment(browserConfig.name),
    ].join('__');
  }

  return sanitizeProfileSegment(credentials.email);
}

export function resolveProfileDir(jobId: string, options: LaunchApolloContextOptions = {}): string {
  const browserConfig = getApolloBrowserConfig();
  const env = getEnv();
  const profileId = env.APOLLO_REUSE_PROFILE === false
    ? (options.profileId ?? jobId)
    : (options.profileId ?? resolveStableProfileId());
  return path.resolve('storage', `${browserConfig.name}-profile`, profileId);
}

export async function launchApolloContext(jobId: string, options: LaunchApolloContextOptions = {}): Promise<BrowserContext> {
  const browserConfig = getApolloBrowserConfig();
  const env = getEnv();
  const profileId = env.APOLLO_REUSE_PROFILE === false
    ? (options.profileId ?? jobId)
    : (options.profileId ?? resolveStableProfileId());
  const userDataDir = resolveProfileDir(jobId, { profileId });
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
      profileId,
      proxy: getProxyFingerprint(),
      locale: browserConfig.locale,
      timezoneId: browserConfig.timezoneId ?? null,
    },
    `Launching persistent ${browserConfig.launchLabel} context`,
  );

  const context = await chromium.launchPersistentContext(userDataDir, {
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

  await bootstrapContextFromCookieSeed(context, jobId);

  return context;
}
