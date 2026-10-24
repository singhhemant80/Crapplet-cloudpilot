import { NextResponse, type NextRequest } from 'next/server';
import { HOME_FOR_ROLE } from './lib/roles';

const AREA_ROLES: Record<string, string[]> = {
  '/admin': ['PLATFORM_ADMIN', 'TENANT_ADMIN', 'STAFF'],
  '/reseller': ['RESELLER_ADMIN'],
  '/customer': ['CUSTOMER'],
};


/** Routing convenience only — real authorization is enforced by the API on every request. */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const area = Object.keys(AREA_ROLES).find((a) => pathname === a || pathname.startsWith(`${a}/`));
  const role = req.cookies.get('cp_role')?.value;
  const hasSession = Boolean(req.cookies.get('cp_rt')?.value);
  if (area && (!hasSession || !role)) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(pathname)}`, req.url));
  if (area && role && !AREA_ROLES[area].includes(role)) return NextResponse.redirect(new URL(HOME_FOR_ROLE[role] ?? '/login', req.url));
  if (pathname === '/' ) return NextResponse.redirect(new URL(hasSession && role ? (HOME_FOR_ROLE[role] ?? '/login') : '/login', req.url));
  return NextResponse.next();
}

export const config = { matcher: ['/', '/admin/:path*', '/reseller/:path*', '/customer/:path*'] };
