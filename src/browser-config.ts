import { getEnv } from './env/schema';

export type ApolloBrowserName = 'edge' | 'chrome' | 'chromium';

export interface ApolloBrowserConfig {
  name: ApolloBrowserName;
  channel?: 'msedge' | 'chrome';
  launchLabel: string;
  locale: string;
  timezoneId?: string;
}

function normalizeBrowserName(value: string | undefined): ApolloBrowserName {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'chrome':
      return 'chrome';
    case 'chromium':
      return 'chromium';
    case 'edge':
    case 'msedge':
    default:
      return 'edge';
  }
}

export function getApolloBrowserConfig(): ApolloBrowserConfig {
  const env = getEnv();
  const name = normalizeBrowserName(env.APOLLO_BROWSER);

  if (name === 'chrome') {
    return {
      name,
      channel: 'chrome',
      launchLabel: 'Google Chrome',
      locale: env.BROWSER_LOCALE ?? 'en-US',
      timezoneId: env.BROWSER_TIMEZONE_ID,
    };
  }

  if (name === 'chromium') {
    return {
      name,
      launchLabel: 'Chromium',
      locale: env.BROWSER_LOCALE ?? 'en-US',
      timezoneId: env.BROWSER_TIMEZONE_ID,
    };
  }

  return {
    name: 'edge',
    channel: 'msedge',
    launchLabel: 'Microsoft Edge',
    locale: env.BROWSER_LOCALE ?? 'en-US',
    timezoneId: env.BROWSER_TIMEZONE_ID,
  };
}
