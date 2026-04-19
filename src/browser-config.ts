export type ApolloBrowserName = 'edge' | 'chrome' | 'chromium';

export interface ApolloBrowserConfig {
  name: ApolloBrowserName;
  channel?: 'msedge' | 'chrome';
  launchLabel: string;
  locale: string;
  timezoneId?: string;
}

function getOptionalBrowserEnv(): {
  browser?: string;
  locale?: string;
  timezoneId?: string;
} {
  return {
    browser: process.env.APOLLO_BROWSER,
    locale: process.env.BROWSER_LOCALE,
    timezoneId: process.env.BROWSER_TIMEZONE_ID,
  };
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
  const env = getOptionalBrowserEnv();
  const name = normalizeBrowserName(env.browser);

  if (name === 'chrome') {
    return {
      name,
      channel: 'chrome',
      launchLabel: 'Google Chrome',
      locale: env.locale ?? 'en-US',
      timezoneId: env.timezoneId,
    };
  }

  if (name === 'chromium') {
    return {
      name,
      launchLabel: 'Chromium',
      locale: env.locale ?? 'en-US',
      timezoneId: env.timezoneId,
    };
  }

  return {
    name: 'edge',
    channel: 'msedge',
    launchLabel: 'Microsoft Edge',
    locale: env.locale ?? 'en-US',
    timezoneId: env.timezoneId,
  };
}
