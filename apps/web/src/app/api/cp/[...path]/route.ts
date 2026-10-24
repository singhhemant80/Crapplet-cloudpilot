import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, API_URL, refreshTokens } from '@/lib/session';

/**
 * Backend-for-frontend proxy: /api/cp/<path> → API /<path>, adding the bearer
 * token from the httpOnly cookie. Mutations require the custom x-cp-csrf header
 * (which cross-site forms cannot send) and a same-origin Origin header.
 */
async function forward(req: NextRequest, path: string[]) {
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (req.headers.get('x-cp-csrf') !== '1' || (origin && new URL(origin).host !== req.headers.get('host'))) {
      return NextResponse.json({ error: { code: 'csrf', message: 'Cross-site request blocked' } }, { status: 403 });
    }
  }
  const target = `${API_URL}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const body = method === 'GET' || method === 'HEAD' ? undefined : await req.text();
  const jar = await cookies();

  const call = (token?: string) =>
    fetch(target, {
      method,
      body,
      cache: 'no-store',
      headers: {
        'content-type': req.headers.get('content-type') ?? 'application/json',
        ...(req.headers.get('idempotency-key') ? { 'idempotency-key': req.headers.get('idempotency-key')! } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-forwarded-for': req.headers.get('x-forwarded-for') ?? '',
      },
    });

  let res = await call(jar.get(ACCESS_COOKIE)?.value);
  if (res.status === 401) {
    const fresh = await refreshTokens();
    if (fresh) res = await call(fresh);
  }
  const headers = new Headers();
  for (const h of ['content-type', 'content-disposition']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { status: res.status, headers });
}

type Ctx = { params: Promise<{ path: string[] }> };
export async function GET(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function PUT(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
