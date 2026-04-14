import type { Page } from 'playwright';

export const APOLLO_LOGIN_URL = 'https://app.apollo.io/#/login?locale=en';

export const APOLLO_PROXY_BYPASS_LIST = [
  '*.microsoftonline.com',
  '*.msauth.net',
  '*.msftauth.net',
  '*.msauthimages.net',
  '*.aadcdn.msftauth.net',
  '*.live.com',
  '*.microsoft.com',
  '*.aadcdn.microsoftonline-p.com',
].join(',');

const BLOCKED_DOMAINS = new Set([
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'facebook.com',
  'hotjar.com',
  'segment.com',
  'mixpanel.com',
  'intercom.io',
  'sentry.io',
  '2o7.net',
  'omtrdc.net',
  'branch.io',
  'amplitude.com',
  'heap.io',
  'heapanalytics.com',
  'fullstory.com',
  'crazyegg.com',
  'mouseflow.com',
  'inspectlet.com',
  'mousestats.com',
  'luckyorange.com',
  'clarity.ms',
]);

const BLOCKED_TYPES = new Set([
  'image',
  'font',
  'media',
  'stylesheet',
  'websocket',
  'preflight',
]);

const MICROSOFT_AUTH_HOST_PATTERNS = [
  'microsoftonline.com',
  'microsoft.com',
  'msauth.net',
  'msftauth.net',
  'msauthimages.net',
  'aadcdn.msftauth.net',
  'aadcdn.microsoftonline-p.com',
  'live.com',
];

export function isMicrosoftAuthUrl(url: string): boolean {
  return MICROSOFT_AUTH_HOST_PATTERNS.some(pattern => url.includes(pattern));
}

function isBlockedDomain(hostname: string): boolean {
  if (BLOCKED_DOMAINS.has(hostname)) {
    return true;
  }

  for (const blocked of BLOCKED_DOMAINS) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      return true;
    }
  }

  return false;
}

async function applyStealth(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const hostname = window.location.hostname;
    const isMicrosoftAuthHost = [
      'microsoftonline.com',
      'microsoft.com',
      'msauth.net',
      'msftauth.net',
      'msauthimages.net',
      'aadcdn.msftauth.net',
      'aadcdn.microsoftonline-p.com',
      'live.com',
    ].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));

    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    });

    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        {
          name: 'Chrome PDF Plugin',
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
        },
        {
          name: 'Chrome PDF Viewer',
          description: '',
          filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
        },
        {
          name: 'Native Client',
          description: '',
          filename: 'internal-nacl-plugin',
        },
      ],
      configurable: true,
    });

    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
      configurable: true,
    });

    if (!isMicrosoftAuthHost) {
      if ((globalThis as Record<string, unknown>).chrome === undefined) {
        (globalThis as Record<string, unknown>).chrome = {};
      }
      Object.defineProperty(globalThis, 'chrome', {
        get: () => ({
          loadTimes: () => ({}),
          csi: () => ({}),
        }),
        configurable: true,
      });
    }

    const permissions = navigator.permissions as Permissions & {
      query?: (permissionDesc: PermissionDescriptor) => Promise<PermissionStatus>;
    };
    const origQuery = permissions.query?.bind(permissions);
    if (origQuery) {
      (permissions as Permissions & {
        query: (permissionDesc: PermissionDescriptor) => Promise<PermissionStatus>;
      }).query = (params: PermissionDescriptor) =>
        origQuery(params).catch(() => Promise.resolve({ state: 'denied' } as PermissionStatus));
    }

    const canvasProto = HTMLCanvasElement.prototype as any;
    const origGetContext = canvasProto.getContext;
    canvasProto.getContext = function (...args: unknown[]) {
      return origGetContext.apply(this, args);
    };
  });

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () =>
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      configurable: true,
    });
  });
}

export async function configureApolloPage(page: Page): Promise<void> {
  await applyStealth(page);

  await page.route('**/*', async route => {
    const request = route.request();
    const url = request.url();
    const type = request.resourceType();

    if (isMicrosoftAuthUrl(url) || url.includes('apollo.io')) {
      await route.continue();
      return;
    }

    const hostname = new URL(url).hostname;
    if (isBlockedDomain(hostname) || BLOCKED_TYPES.has(type)) {
      await route.abort();
      return;
    }

    await route.continue();
  });
}
