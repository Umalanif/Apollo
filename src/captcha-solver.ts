import { URLSearchParams } from 'node:url';
import { getEnv } from './env/schema';
import { logger } from './logger';
import { createProxyAgents, getMaskedProxyUrl } from './proxy';

const RETRYABLE_CODES = new Set([
  'ERROR_KEY_DOES_NOT_EXIST',
  'ERROR_ZERO_CAPTCHA_FILESIZE',
  'ERROR_TOO_SMALL_CAPTCHA_FILESIZE',
  'ERROR_WRONG_CAPTCHA_FILE',
  'ERROR_CAPTCHA_UNSOLVABLE',
  'ERROR_WRONG_USER_KEY',
  'ERROR_WRONG_ID_FORMAT',
  'ERROR_BAD_TOKEN_OR_PAGEURL',
  'ERROR_IP_NOT_ALLOWED',
  'ERROR_TOKEN_EXPIRED',
  'ERROR_IP_ADDR',
  'ERROR_DOMAIN_NOT_ALLOWED',
  'ERROR_2CAPTCHA_BLOCKED',
  'ERROR_TOO_MUCH_REQUESTS',
]);

const MAX_ATTEMPTS = 3;
const SUBMIT_DELAY_MS = 5_000;
const POLL_DELAY_MS = 5_000;

interface TwoCaptchaSuccess {
  status: 1;
  request: string;
}

interface TwoCaptchaFailure {
  status: 0;
  request: string;
}

type TwoCaptchaResponse = TwoCaptchaSuccess | TwoCaptchaFailure;

export interface SolveRecaptchaOptions {
  extraOptions?: Record<string, string | number | boolean | undefined>;
  userAgent?: string;
}

export interface SolveTurnstileOptions {
  extraOptions?: Record<string, string | number | boolean | undefined>;
}

function isRetryable(code: string): boolean {
  return RETRYABLE_CODES.has(code);
}

function buildProxyPayload(): Record<string, string> {
  const { PROXY_HOST, PROXY_PASSWORD, PROXY_PORT, PROXY_USERNAME } = getEnv();

  return {
    proxy: `${PROXY_USERNAME}:${PROXY_PASSWORD}@${PROXY_HOST}:${PROXY_PORT}`,
    proxytype: 'http',
  };
}

async function getTwoCaptchaClient() {
  const { got } = await import('got');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (got as any).extend({
    prefixUrl: 'https://2captcha.com',
    agent: createProxyAgents(),
    timeout: {
      request: 30_000,
    },
    responseType: 'json',
    retry: {
      limit: 1,
    },
  });
}

function buildSubmitPayload(
  method: 'userrecaptcha' | 'turnstile',
  params: Record<string, string | number | boolean | undefined>,
): URLSearchParams {
  const { TWO_CAPTCHA_API_KEY } = getEnv();
  const payload = new URLSearchParams();

  payload.set('key', TWO_CAPTCHA_API_KEY);
  payload.set('json', '1');
  payload.set('header_acao', '1');
  payload.set('soft_id', '3898');
  payload.set('method', method);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }

    payload.set(key, String(value));
  }

  return payload;
}

function unwrapTwoCaptchaResponse(response: TwoCaptchaResponse): string {
  if (response.status === 1) {
    return response.request;
  }

  throw new Error(response.request);
}

async function submitAndPoll(
  method: 'userrecaptcha' | 'turnstile',
  payload: URLSearchParams,
  logLabel: string,
): Promise<string> {
  const client = await getTwoCaptchaClient();
  const { TWO_CAPTCHA_API_KEY } = getEnv();

  logger.info(
    {
      method,
      proxy: getMaskedProxyUrl(),
    },
    `Submitting ${logLabel} to 2captcha`,
  );

  const submitResponse = await client.post('in.php', {
    body: payload.toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
  });

  const submitId = unwrapTwoCaptchaResponse(submitResponse.body as TwoCaptchaResponse);

  while (true) {
    await new Promise(resolve => setTimeout(resolve, POLL_DELAY_MS));

    const pollResponse = await client.get('res.php', {
      searchParams: {
        key: TWO_CAPTCHA_API_KEY,
        action: 'get',
        id: submitId,
        json: '1',
      },
    });

    const body = pollResponse.body as TwoCaptchaResponse;
    if (body.status === 1) {
      return body.request;
    }

    if (body.request === 'CAPCHA_NOT_READY') {
      continue;
    }

    throw new Error(body.request);
  }
}

export async function solveRecaptcha(
  sitekey: string,
  pageUrl: string,
  opts: SolveRecaptchaOptions = {},
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const payload = buildSubmitPayload('userrecaptcha', {
        googlekey: sitekey,
        pageurl: pageUrl,
        userAgent: opts.userAgent,
        ...buildProxyPayload(),
        ...opts.extraOptions,
      });

      const token = await submitAndPoll('userrecaptcha', payload, 'reCAPTCHA');

      logger.info(
        { tokenPreview: token.slice(0, 20) + '...', provider: '2captcha' },
        'reCAPTCHA solved successfully',
      );

      return token;
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      lastError = err instanceof Error ? err : new Error(code);
      const retryable = isRetryable(code);

      logger.warn(
        { attempt, maxAttempts: MAX_ATTEMPTS, code, retryable },
        `2captcha solve attempt ${attempt} failed`,
      );

      if (!retryable) {
        throw lastError;
      }

      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, SUBMIT_DELAY_MS));
      }
    }
  }

  throw lastError ?? new Error('reCAPTCHA solve failed after max attempts');
}

export async function solveCloudflareTurnstile(
  sitekey: string,
  pageUrl: string,
  opts: SolveTurnstileOptions = {},
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const payload = buildSubmitPayload('turnstile', {
        sitekey,
        pageurl: pageUrl,
        ...buildProxyPayload(),
        ...opts.extraOptions,
      });

      const token = await submitAndPoll('turnstile', payload, 'Cloudflare Turnstile');

      logger.info(
        { tokenPreview: token.slice(0, 20) + '...', provider: '2captcha' },
        'Cloudflare Turnstile solved successfully',
      );

      return token;
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      lastError = err instanceof Error ? err : new Error(code);
      const retryable = isRetryable(code);

      logger.warn(
        { attempt, maxAttempts: MAX_ATTEMPTS, code, retryable },
        `2captcha turnstile solve attempt ${attempt} failed`,
      );

      if (!retryable) {
        throw lastError;
      }

      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, SUBMIT_DELAY_MS));
      }
    }
  }

  throw lastError ?? new Error('Cloudflare Turnstile solve failed after max attempts');
}
