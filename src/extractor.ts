import type { Page } from 'playwright';
import { wrap } from './bottleneck';
import { logger } from './logger';
import { createProxyAgents, getMaskedProxyUrl } from './proxy';

export interface SessionAuth {
  csrfToken: string;
  cookies: string;
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
}

export interface LoadSnippetsResponse {
  organizations: ApolloOrganization[];
}

export interface ExtractorDeps {
  jobId: string;
  auth: SessionAuth;
  requestHeaders?: Record<string, string>;
  refererUrl?: string;
  userAgent?: string;
}

type GotInstance = ReturnType<typeof import('got').got.extend>;

const FORWARDED_HEADER_NAMES = [
  'accept',
  'accept-language',
  'content-type',
  'origin',
  'priority',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-gpc',
  'x-accept-language',
  'x-referer-host',
  'x-referer-path',
  'x-requested-with',
];

function normalizeRefererPath(refererUrl?: string): string {
  if (!refererUrl) {
    return '/people';
  }

  try {
    const parsed = new URL(refererUrl);
    return parsed.hash.startsWith('#/people') ? '/people' : (parsed.hash || parsed.pathname || '/people');
  } catch {
    return '/people';
  }
}

function buildApolloHeaders(
  auth: SessionAuth,
  requestHeaders?: Record<string, string>,
  refererUrl?: string,
  userAgent?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    referer: refererUrl ?? 'https://app.apollo.io/',
    cookie: auth.cookies,
    'x-csrf-token': auth.csrfToken,
    'x-referer-host': 'app.apollo.io',
    'x-referer-path': normalizeRefererPath(refererUrl),
  };

  if (userAgent) {
    headers['user-agent'] = userAgent;
  }

  for (const name of FORWARDED_HEADER_NAMES) {
    const value = requestHeaders?.[name];
    if (value) {
      headers[name] = value;
    }
  }

  if (!headers.accept) {
    headers.accept = 'application/json, text/plain, */*';
  }

  if (!headers['accept-language']) {
    headers['accept-language'] = 'en-US,en;q=0.9';
  }

  if (!headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  if (!headers.origin) {
    headers.origin = 'https://app.apollo.io';
  }

  if (!headers['sec-fetch-dest']) {
    headers['sec-fetch-dest'] = 'empty';
  }

  if (!headers['sec-fetch-mode']) {
    headers['sec-fetch-mode'] = 'cors';
  }

  if (!headers['sec-fetch-site']) {
    headers['sec-fetch-site'] = 'same-origin';
  }

  return headers;
}

export async function createApolloClient(deps: ExtractorDeps): Promise<GotInstance> {
  const { auth, jobId, refererUrl, requestHeaders, userAgent } = deps;
  const { got } = await import('got');
  const agents = createProxyAgents();

  logger.debug(
    {
      jobId,
      proxy: getMaskedProxyUrl(),
      hasRequestHeaders: Boolean(requestHeaders && Object.keys(requestHeaders).length > 0),
      refererUrl,
    },
    'Creating Apollo got client',
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (got as any).extend({
    prefixUrl: 'https://app.apollo.io',
    agent: agents,
    headers: buildApolloHeaders(auth, requestHeaders, refererUrl, userAgent),
    timeout: {
      request: 30_000,
    },
    retry: {
      limit: 2,
      methods: ['POST', 'GET'],
      statusCodes: [408, 429, 500, 502, 503, 504],
      errorCodes: ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED'],
    },
    responseType: 'text',
  }) as GotInstance;
}

export async function postApolloJson(
  client: GotInstance,
  path: string,
  body: unknown,
): Promise<{ payload: unknown; rawBody: string; status: number; contentType: string; responseUrl: string }> {
  const response = await client.post(path, {
    json: body,
  });

  const rawBody = String(response.body);
  return {
    payload: JSON.parse(rawBody) as unknown,
    rawBody,
    status: response.statusCode,
    contentType: response.headers['content-type'] ?? '',
    responseUrl: response.url,
  };
}

export async function loadOrganizationSnippets(
  client: GotInstance,
  ids: string[],
  cacheKey: number = Date.now(),
): Promise<LoadSnippetsResponse> {
  return wrap(async () => {
    logger.debug({ orgCount: ids.length, cacheKey }, 'load_snippets request');

    const response = await postApolloJson(client, 'api/v1/organizations/load_snippets', {
      ids,
      cacheKey,
    });

    const body = response.payload as LoadSnippetsResponse;
    logger.debug({ orgCount: body.organizations?.length ?? 0 }, 'load_snippets response');

    return body;
  });
}

export async function extractSessionAuth(page: Page): Promise<SessionAuth> {
  const currentApolloUrl = page.url().includes('apollo.io') ? page.url() : 'https://app.apollo.io/';
  const cookies = await page.context().cookies(currentApolloUrl);
  const apolloCookies = cookies.filter(cookie => cookie.domain === 'apollo.io' || cookie.domain.endsWith('.apollo.io'));
  const csrfToken = apolloCookies.find(cookie => cookie.name === 'X-CSRF-TOKEN')?.value ?? '';
  const cookieString = apolloCookies
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');

  logger.debug(
    {
      csrfToken: csrfToken ? `${csrfToken.slice(0, 10)}...` : '',
      hasCsrfCookie: Boolean(csrfToken),
      cookieCount: apolloCookies.length,
      pageUrl: page.url(),
    },
    'Session auth extracted',
  );

  return { csrfToken, cookies: cookieString };
}
