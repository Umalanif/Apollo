import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { getEnv } from './env/schema';
import { logger } from './logger';

type SeedCookieParam = Parameters<BrowserContext['addCookies']>[0][number];

interface CookieSeedRecord {
  domain?: string;
  expirationDate?: number;
  hostOnly?: boolean;
  httpOnly?: boolean;
  name?: string;
  path?: string;
  sameSite?: string | null;
  secure?: boolean;
  value?: string;
}

interface CookieSeedDecision {
  accepted: boolean;
  cookie?: SeedCookieParam;
  reason?: string;
}

export interface CookieSeedBootstrapOptions {
  includeCloudflareCookies?: boolean;
}

const APOLLO_COOKIE_NAMES = new Set([
  'app_token',
  '_leadgenie_session',
  'remember_token_leadgenie_v2',
  'X-CSRF-TOKEN',
  'zp_device_id',
  'dwnjrn',
  'dwndvc',
  'ZP_LATEST_LOGIN_PRICING_VARIANT',
  'ZP_Pricing_Split_Test_Variant',
]);

function normalizeSameSite(value: string | null | undefined): SeedCookieParam['sameSite'] | undefined {
  if (!value) {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case 'lax':
      return 'Lax';
    case 'strict':
      return 'Strict';
    case 'no_restriction':
    case 'none':
      return 'None';
    default:
      return undefined;
  }
}

export function filterSeedCookie(
  input: CookieSeedRecord,
  includeCloudflareCookies = false,
): CookieSeedDecision {
  const name = input.name?.trim();
  const rawDomain = input.domain?.trim().toLowerCase();

  if (!name || !rawDomain || typeof input.value !== 'string') {
    return { accepted: false, reason: 'missing required cookie fields' };
  }

  if (!rawDomain.includes('apollo.io')) {
    return { accepted: false, reason: `non-apollo cookie domain: ${rawDomain}` };
  }

  if (name.startsWith('__cf') && !includeCloudflareCookies) {
    return { accepted: false, reason: `cloudflare cookie excluded by policy: ${name}` };
  }

  if (!name.startsWith('__cf') && !APOLLO_COOKIE_NAMES.has(name)) {
    return { accepted: false, reason: `cookie not allowlisted for seed bootstrap: ${name}` };
  }

  const cookie: SeedCookieParam = {
    name,
    value: input.value,
    domain: rawDomain,
    path: input.path || '/',
    httpOnly: Boolean(input.httpOnly),
    secure: input.secure !== false,
  };

  const sameSite = normalizeSameSite(input.sameSite);
  if (sameSite) {
    cookie.sameSite = sameSite;
  }

  if (typeof input.expirationDate === 'number' && Number.isFinite(input.expirationDate)) {
    cookie.expires = Math.floor(input.expirationDate);
  }

  return { accepted: true, cookie };
}

async function loadSeedCookies(seedPath: string): Promise<CookieSeedRecord[]> {
  const raw = await readFile(seedPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('Cookie seed file must contain a JSON array');
  }

  return parsed as CookieSeedRecord[];
}

export async function bootstrapContextFromCookieSeed(
  context: BrowserContext,
  jobId: string,
  options: CookieSeedBootstrapOptions = {},
): Promise<void> {
  const env = getEnv();
  const seedPath = env.APOLLO_COOKIE_SEED_PATH?.trim();
  const includeCloudflareCookies = options.includeCloudflareCookies ?? (env.APOLLO_COOKIE_SEED_INCLUDE_CF === true);

  if (!seedPath) {
    return;
  }

  const resolvedPath = path.resolve(seedPath);
  try {
    const sourceCookies = await loadSeedCookies(resolvedPath);
    const accepted: SeedCookieParam[] = [];
    const rejected: Array<{ name: string; domain: string; reason: string }> = [];

    for (const entry of sourceCookies) {
      const decision = filterSeedCookie(entry, includeCloudflareCookies);
      if (decision.accepted && decision.cookie) {
        accepted.push(decision.cookie);
        continue;
      }

      rejected.push({
        name: entry.name?.trim() || '<missing>',
        domain: entry.domain?.trim() || '<missing>',
        reason: decision.reason ?? 'unknown',
      });
    }

    if (accepted.length > 0) {
      await context.addCookies(accepted);
    }

    logger.info(
      {
        jobId,
        seedPath: resolvedPath,
        acceptedCookieNames: accepted.map(cookie => cookie.name),
        rejectedCookies: rejected,
        includeCloudflareCookies,
      },
      'Cookie seed bootstrap completed',
    );
  } catch (err) {
    logger.warn(
      {
        jobId,
        seedPath: resolvedPath,
        err: err instanceof Error ? err.message : String(err),
      },
      'Cookie seed bootstrap failed',
    );
  }
}
