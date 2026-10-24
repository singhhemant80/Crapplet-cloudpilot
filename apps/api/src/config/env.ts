import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379/0'),
  /** 32 random bytes, base64. Encrypts provider credentials & webhook secrets at rest. */
  APP_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes base64'),
  JWT_SECRET: z.string().min(32),
  API_PORT: z.coerce.number().default(4000),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  /** HMAC secret of the built-in sandbox payment gateway (dev/staging only). */
  SANDBOX_GATEWAY_SECRET: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  /** Allow webhook delivery to private/loopback addresses (development only). */
  WEBHOOK_ALLOW_PRIVATE_TARGETS: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  IP_RESERVATION_MINUTES: z.coerce.number().default(30),
  PROVISIONING_MAX_ATTEMPTS: z.coerce.number().default(3),
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof schema>;

/** Minimal .env loader (no dependency); real environment variables always win. */
function loadDotEnv() {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  loadDotEnv();
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (env.SANDBOX_GATEWAY_SECRET) throw new Error('SANDBOX_GATEWAY_SECRET must not be set in production');
    if (env.WEBHOOK_ALLOW_PRIVATE_TARGETS) throw new Error('WEBHOOK_ALLOW_PRIVATE_TARGETS must be false in production');
  }
  cached = env;
  return env;
}

export function resetEnvCache() {
  cached = undefined;
}
