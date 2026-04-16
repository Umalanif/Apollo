import { config } from 'dotenv';
import { z } from 'zod';

config();

const EMOJI_REGEX = /\p{Emoji}/u;
const URL_REGEX = /^https:\/\/www\.linkedin\.com\/in\/[\w-]+\/?$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function stripEmoji(str: string): string {
  return str.replace(EMOJI_REGEX, '');
}

function toTitleCase(str: string): string {
  return str
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export const LeadSchema = z.object({
  linkedInUrl: z.string().trim().regex(URL_REGEX, 'Invalid LinkedIn URL format'),
  firstName: z.string().min(1).transform(val => toTitleCase(stripEmoji(val.trim()))),
  lastName: z.string().min(1).transform(val => toTitleCase(stripEmoji(val.trim()))),
  title: z.string().optional().transform(val => val ? stripEmoji(val.trim()) : undefined),
  company: z.string().optional().transform(val => val ? stripEmoji(val.trim()) : undefined),
  companyUrl: z.string().optional().transform(val => val ? stripEmoji(val.trim()) : undefined),
  location: z.string().optional().transform(val => val ? stripEmoji(val.trim()) : undefined),
  email: z.string().regex(EMAIL_REGEX, 'Invalid email format').or(z.literal('')).optional(),
  phone: z.string().optional().transform(val => val ? stripEmoji(val.trim()) : undefined),
});

export type LeadInput = z.infer<typeof LeadSchema>;
export type LeadOutput = z.output<typeof LeadSchema>;

const EnvSchema = z.object({
  PROXY_HOST: z.string().min(1, 'PROXY_HOST is required'),
  PROXY_USERNAME: z.string().min(1, 'PROXY_USERNAME is required'),
  PROXY_PASSWORD: z.string().min(1, 'PROXY_PASSWORD is required'),
  PROXY_PORT: z.coerce.number().int().min(1).max(65535),
  TWO_CAPTCHA_API_KEY: z.string().min(1, 'TWO_CAPTCHA_API_KEY is required'),
  APOLLO_BROWSER: z.enum(['edge', 'msedge', 'chrome', 'chromium']).optional(),
  BROWSER_LOCALE: z.string().min(2).optional(),
  BROWSER_TIMEZONE_ID: z.string().min(1).optional(),
  CLOUDFLARE_PROBE_URL: z.string().url().optional(),
  APOLLO_EMAIL: z.string().email('APOLLO_EMAIL must be a valid email').optional(),
  APOLLO_PASSWORD: z.string().min(1, 'APOLLO_PASSWORD is required').optional(),
  APOLLO_MS_EMAIL: z.string().email('APOLLO_MS_EMAIL must be a valid email').optional(),
  APOLLO_MS_PASSWORD: z.string().min(1, 'APOLLO_MS_PASSWORD is required').optional(),
}).superRefine((env, ctx) => {
  if (!(env.APOLLO_MS_EMAIL ?? env.APOLLO_EMAIL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APOLLO_MS_EMAIL'],
      message: 'APOLLO_MS_EMAIL or APOLLO_EMAIL is required',
    });
  }

  if (!(env.APOLLO_MS_PASSWORD ?? env.APOLLO_PASSWORD)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APOLLO_MS_PASSWORD'],
      message: 'APOLLO_MS_PASSWORD or APOLLO_PASSWORD is required',
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

let envInstance: Env | null = null;

export function validateEnv(): Env {
  if (envInstance) return envInstance;

  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Environment validation failed: ${errors}`);
  }

  envInstance = result.data;
  return envInstance;
}

export function getEnv(): Env {
  if (!envInstance) {
    return validateEnv();
  }
  return envInstance;
}

export function getMicrosoftCredentials(): { email: string; password: string } {
  const env = getEnv();
  return {
    email: env.APOLLO_MS_EMAIL ?? env.APOLLO_EMAIL ?? '',
    password: env.APOLLO_MS_PASSWORD ?? env.APOLLO_PASSWORD ?? '',
  };
}
