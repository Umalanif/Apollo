/**
 * Apollo API Extractor â€” got client for hidden XHR/GraphQL endpoints
 *
 * Phase 7.1: Mirrors Playwright proxy config (same IP across browser + API),
 *            uses Bottleneck for 3-15s request throttling.
 *
 * Session auth: CSRF token + session cookies injected from Playwright page context.
 * Retry loop: increments proxy port on failure â†’ new sticky exit IP.
 *
 * Key endpoint discovered from live traffic:
 *   POST https://app.apollo.io/api/v1/organizations/load_snippets
 */

import { buildProxyUrl } from './crawler';
import { wrap } from './bottleneck';
import { logger } from './logger';
import { HttpProxyAgent } from 'http-proxy-agent';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface SessionAuth {
  csrfToken: string;
  cookies: string; // full cookie string from page context
}

export interface ApolloOrganization {
  id: string;
  name?: string;
  linkedin_url?: string;
  industry?: string;
  estimated_num_employees?: number;
  city?: string;
  state?: string;
  country?: string;
  // â€¦ additional fields from response.json
}

export interface LoadSnippetsResponse {
  organizations: ApolloOrganization[];
  // â€¦ additional pagination/meta fields
}

export interface ExtractorDeps {
  jobId: string;
  proxyPort: number;
  auth: SessionAuth;
}

// â”€â”€ got callable instance type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type GotInstance = ReturnType<typeof import('got').got.extend>;

// â”€â”€ Static Apollo headers (mirror Playwright browser headers) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildApolloHeaders(auth: SessionAuth): Record<string, string> {
  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Brave";v="146"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'sec-gpc': '1',
    'x-accept-language': 'en',
    'x-csrf-token': auth.csrfToken,
    'x-referer-host': 'app.apollo.io',
    'x-referer-path': '/people',
    referer: 'https://app.apollo.io/',
    cookie: auth.cookies,
  };
}

// â”€â”€ got instance factory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Create a got instance pre-configured for Apollo API calls.
 * Uses HttpProxyAgent to route traffic through the same DataImpulse proxy
 * as the Playwright browser context (same exit IP).
 *
 * got.extend() exists at runtime but is not fully typed in got v12's TypeScript definitions.
 * We access it via `import('got').got.extend` to satisfy the type checker.
 */
export async function createApolloClient(deps: ExtractorDeps): Promise<GotInstance> {
  const { jobId, proxyPort, auth } = deps;
  const proxyUrl = buildProxyUrl(proxyPort);

  logger.debug(
    { jobId, proxyPort, proxyHost: proxyUrl.replace(/:[^:@]+@/, ':***@') },
    'Creating Apollo got client',
  );

  // Dynamic import to access the runtime-extant got.got.extend function
  const { got } = await import('got');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (got as any).extend({
    prefixUrl: 'https://app.apollo.io',

    // â”€â”€ Proxy: same IP as Playwright browser context via HttpProxyAgent â”€â”€â”€â”€â”€â”€
    agent: {
      http: new HttpProxyAgent(proxyUrl),
      https: new HttpProxyAgent(proxyUrl),
    },

    // â”€â”€ Headers: mirrors live browser traffic exactly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    headers: buildApolloHeaders(auth),

    // â”€â”€ Timeout: generous enough for slow proxy + Apollo API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    timeout: {
      request: 30_000,
    },

    // â”€â”€ Retry on network / 5xx failures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    retry: {
      limit: 2,
      methods: ['POST', 'GET'],
      statusCodes: [408, 429, 500, 502, 503, 504],
      errorCodes: ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED'],
    },

    // â”€â”€ Response parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    responseType: 'json',
  });

  return client as GotInstance;
}

// â”€â”€ Throttled API call to load_snippets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Fetch organization detail snippets from Apollo's hidden load_snippets endpoint.
 * Throttled via Bottleneck (3-15s random delay).
 *
 * @param client   - got instance created via createApolloClient()
 * @param ids      - Array of Apollo organization ID strings
 * @param cacheKey - Unix timestamp (ms) used as Apollo cache buster
 */
export async function loadOrganizationSnippets(
  client: GotInstance,
  ids: string[],
  cacheKey: number = Date.now(),
): Promise<LoadSnippetsResponse> {
  return wrap(async () => {
    logger.debug({ orgCount: ids.length, cacheKey }, 'load_snippets request');

    const response = await client.post('api/v1/organizations/load_snippets', {
      json: {
        ids,
        cacheKey,
      },
    });

    const body = response.body as unknown as LoadSnippetsResponse;
    logger.debug({ orgCount: body.organizations?.length ?? 0 }, 'load_snippets response');

    return body;
  });
}

// â”€â”€ CSRF + cookie extractor from Playwright page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Pull CSRF token and full cookie string from a live Playwright page.
 * Call this INSIDE a Playwright requestHandler after the page has loaded
 * a protected Apollo route (e.g. after session hydration).
 *
 * @example
 *   const auth = await extractSessionAuth(page);
 *   // pass auth to worker / extractor
 */
export async function extractSessionAuth(
  page: import('playwright').Page,
): Promise<SessionAuth> {
  const csrfToken = await page.evaluate(() => {
    // Apollo stores CSRF in a meta tag
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) return meta.getAttribute('content') ?? '';

    // Fallback: read from window property injected by Apollo
    return ((window as unknown) as Record<string, unknown>).__csrfToken as string ?? '';
  });

  const currentApolloUrl = page.url().includes('apollo.io') ? page.url() : 'https://app.apollo.io/';
  const cookies = await page.context().cookies(currentApolloUrl);
  const apolloCookies = cookies.filter(cookie => cookie.domain === 'apollo.io' || cookie.domain.endsWith('.apollo.io'));
  const cookieString = apolloCookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  logger.debug(
    { csrfToken: csrfToken.slice(0, 10) + '...', cookieCount: apolloCookies.length, pageUrl: page.url() },
    'Session auth extracted',
  );

  return { csrfToken, cookies: cookieString };
}
