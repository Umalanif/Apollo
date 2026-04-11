import { z } from 'zod';
import { config } from 'dotenv';

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
  TWO_CAPTCHA_API_KEY: z.string().min(1, 'TWO_CAPTCHA_API_KEY is required'),
  APOLLO_SESSION_COOKIE: z.string().min(1, 'APOLLO_SESSION_COOKIE is required'),
  BRAVE_USER_AGENT: z.string().optional(),
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