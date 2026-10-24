import { NextResponse, type NextRequest } from 'next/server';
import { HOME_FOR_ROLE } from './lib/roles';

const AREA_ROLES: Record<string, string[]> = {
  '/admin': ['PLATFORM_ADMIN', 'TENANT_ADMIN', 'STAFF'],
  '/reseller': ['RESELLER_ADMIN'],
  '/customer': ['CUSTOMER'],
};

/**
 * Absolute URL on the address the visitor actually used. Behind nginx, req.url carries the
 * internal listener (localhost:3000), so redirects are built from the forwarded Host/proto.
 */
function at(req: NextRequest, path: string) {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
  const proto = (req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '')).split(',')[0].trim();
  return new URL(path, `${proto}://${host}`);
}

/** Routing convenience only — real authorization is enforced by the API on every request. */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const area = Object.keys(AREA_ROLES).find((a) => pathname === a || pathname.startsWith(`${a}/`));
  const role = req.cookies.get('cp_role')?.value;
  const hasSession = Boolean(req.cookies.get('cp_rt')?.value);
  if (area && (!hasSession || !role)) return NextResponse.redirect(at(req, `/login?next=${encodeURIComponent(pathname)}`));
  if (area && role && !AREA_ROLES[area].includes(role)) return NextResponse.redirect(at(req, HOME_FOR_ROLE[role] ?? '/login'));
  if (pathname === '/') return NextResponse.redirect(at(req, hasSession && role ? (HOME_FOR_ROLE[role] ?? '/login') : '/login'));
  return NextResponse.next();
}

export const config = { matcher: ['/', '/admin/:path*', '/reseller/:path*', '/customer/:path*'] };
