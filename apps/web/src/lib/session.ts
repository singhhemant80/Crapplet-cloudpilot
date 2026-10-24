import { cookies } from 'next/headers';

export const API_URL = process.env.CLOUDPILOT_API_URL ?? 'http://127.0.0.1:4000';
export const ACCESS_COOKIE = 'cp_at';
export const REFRESH_COOKIE = 'cp_rt';
export const ROLE_COOKIE = 'cp_role'; // non-sensitive hint for routing only; the API re-checks everything

// Secure cookies unless explicitly disabled (plain-HTTP test installs set COOKIE_SECURE=false).
const secure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user?: { role: string };
}

/** Tokens live only in httpOnly, SameSite=Strict cookies; browser JavaScript never sees them. */
export async function storeTokens(t: TokenPair) {
  const jar = await cookies();
  const base = { httpOnly: true, sameSite: 'strict' as const, secure, path: '/' };
  jar.set(ACCESS_COOKIE, t.accessToken, { ...base, maxAge: t.expiresIn });
  jar.set(REFRESH_COOKIE, t.refreshToken, { ...base, maxAge: 30 * 24 * 3600 });
  if (t.user?.role) jar.set(ROLE_COOKIE, t.user.role, { ...base, maxAge: 30 * 24 * 3600 });
}

export async function clearTokens() {
  const jar = await cookies();
  for (const n of [ACCESS_COOKIE, REFRESH_COOKIE, ROLE_COOKIE]) jar.delete(n);
}

export async function refreshTokens(): Promise<string | null> {
  const jar = await cookies();
  const rt = jar.get(REFRESH_COOKIE)?.value;
  if (!rt) return null;
  const res = await fetch(`${API_URL}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const t = (await res.json()) as TokenPair;
  await storeTokens(t);
  return t.accessToken;
}
