import { NextResponse, type NextRequest } from 'next/server';
import { API_URL, clearTokens, storeTokens, type TokenPair } from '@/lib/session';

/** POST: log in (credentials go server-to-server; tokens come back as httpOnly cookies). DELETE: log out. */
export async function POST(req: NextRequest) {
  if (req.headers.get('x-cp-csrf') !== '1') return NextResponse.json({ error: { message: 'Blocked' } }, { status: 403 });
  const body = await req.text();
  const res = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': req.headers.get('x-forwarded-for') ?? '' },
    body,
    cache: 'no-store',
  });
  const data = await res.json();
  if (!res.ok) return NextResponse.json(data, { status: res.status });
  await storeTokens(data as TokenPair);
  return NextResponse.json({ user: (data as { user: unknown }).user });
}

export async function DELETE(req: NextRequest) {
  if (req.headers.get('x-cp-csrf') !== '1') return NextResponse.json({ error: { message: 'Blocked' } }, { status: 403 });
  const at = req.cookies.get('cp_at')?.value;
  if (at) await fetch(`${API_URL}/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${at}` } }).catch(() => undefined);
  await clearTokens();
  return NextResponse.json({ ok: true });
}
