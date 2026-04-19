import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { getApolloBrowserConfig } from './browser-config';
import { bootstrapContextFromCookieSeed } from './cookie-seed';
import { getEnv, getMicrosoftCredentials } from './env/schema';
import { logger } from './logger';
import { getPlaywrightProxy, getProxyFingerprint } from './proxy';

export interface LaunchApolloContextOptions {
  profileId?: string;
  forceFreshProfile?: boolean;
  includeCloudflareSeedCookies?: boolean;
}

function getReuseProfileFlag(): boolean {
  return process.env.APOLLO_REUSE_PROFILE?.trim().toLowerCase() === 'true';
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
  const browserConfig = getApolloBrowserConfig();
  const credentials = getMicrosoftCredentials();

  return [
    sanitizeProfileSegment(credentials.email),
    sanitizeProfileSegment(getProxyFingerprint()),
    sanitizeProfileSegment(browserConfig.name),
  ].join('__');
}

function resolveLaunchProfileId(reuseProfile: boolean, jobId: string, options: LaunchApolloContextOptions = {}): string {
  if (options.profileId) {
    return options.profileId;
  }

  return reuseProfile ? resolveStableProfileId() : jobId;
}

export function resolveProfileDir(jobId: string, options: LaunchApolloContextOptions = {}): string {
  const browserConfig = getApolloBrowserConfig();
  const reuseProfile = getReuseProfileFlag() && options.forceFreshProfile !== true;
  const profileId = resolveLaunchProfileId(reuseProfile, jobId, options);
  return path.resolve('storage', `${browserConfig.name}-profile`, profileId);
}

export async function launchApolloContext(jobId: string, options: LaunchApolloContextOptions = {}): Promise<BrowserContext> {
  const browserConfig = getApolloBrowserConfig();
  const env = getEnv();
  const reuseProfile = (env.APOLLO_REUSE_PROFILE ?? false) && options.forceFreshProfile !== true;
  const profileId = resolveLaunchProfileId(reuseProfile, jobId, options);
  const profileRootDir = resolveProfileDir(jobId, { profileId });
  await mkdir(profileRootDir, { recursive: true });
  const userDataDir = reuseProfile
    ? profileRootDir
    : await mkdtemp(path.join(profileRootDir, 'run-'));
  const launchArgs = [
    `--lang=${browserConfig.locale}`,
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-blink-features=AutomationControlled',
  ];

  logger.info(
    {
      jobId,
      browser: browserConfig.name,
      browserChannel: browserConfig.channel ?? 'bundled',
      profileRootDir,
      userDataDir,
      profileId,
      reuseProfile,
      forceFreshProfile: options.forceFreshProfile === true,
      proxy: getProxyFingerprint(),
      locale: browserConfig.locale,
      timezoneId: browserConfig.timezoneId ?? null,
    },
    reuseProfile
      ? `Launching reusable ${browserConfig.launchLabel} context`
      : `Launching isolated ${browserConfig.launchLabel} context`,
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

  await bootstrapContextFromCookieSeed(context, jobId, {
    includeCloudflareCookies: options.includeCloudflareSeedCookies ?? (reuseProfile && env.APOLLO_COOKIE_SEED_INCLUDE_CF === true),
  });

  context.on('close', () => {
    if (reuseProfile) {
      return;
    }

    void rm(userDataDir, { recursive: true, force: true }).catch(err => {
      logger.warn(
        { jobId, userDataDir, err: err instanceof Error ? err.message : String(err) },
        'Failed to remove temporary browser profile directory',
      );
    });
  });

  return context;
}
