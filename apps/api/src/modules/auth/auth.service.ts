import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { randomBytes } from 'node:crypto';
import type { Database } from '../../db/client';
import { apiCredentials, resellers, sessions, tenants, users } from '../../db/schema';
import { randomToken, safeEqualHex, sha256Hex } from '../../common/crypto';
import { cidrContains } from '../../common/ip';
import { DomainError, Invalid, NotFound } from '../../common/errors';
import { audit, type AuditActor } from '../../common/audit';
import { isIP } from 'node:net';

export type Role = (typeof users.$inferSelect)['role'];

export const API_SCOPES = [
  'products:read',
  'orders:read',
  'orders:write',
  'services:read',
  'services:write',
  'wallet:read',
  'wallet:write',
  'ipam:read',
  'ipam:write',
  'webhooks:manage',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface Principal {
  kind: 'user' | 'api_key';
  tenantId: string;
  userId?: string;
  sessionId?: string;
  role?: Role;
  resellerId?: string;
  customerId?: string;
  apiKeyId?: string;
  scopes: ReadonlySet<string>;
  ip?: string;
}

export function actorOf(p: Principal): AuditActor {
  return p.kind === 'user' ? { type: 'user', id: p.userId, ip: p.ip } : { type: 'api_key', id: p.apiKeyId, ip: p.ip };
}

/** Role → permission strings used by admin routes. Reseller and customer access is scoped by ownership instead. */
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  PLATFORM_ADMIN: ['*'],
  TENANT_ADMIN: ['*'],
  STAFF: ['admin:read', 'orders:manage', 'deposits:review', 'services:manage'],
  RESELLER_ADMIN: [],
  CUSTOMER: [],
};

export function hasPermission(p: Principal, perm: string) {
  if (p.kind !== 'user' || !p.role) return false;
  const perms = ROLE_PERMISSIONS[p.role];
  return perms.includes('*') || perms.includes(perm);
}

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
// Fixed dummy hash so unknown-email logins take the same time as wrong-password ones.
let dummyHash: Promise<string> | undefined;

export class AuthService {
  private readonly key: Uint8Array;

  constructor(
    private readonly db: Database,
    jwtSecret: string,
  ) {
    this.key = new TextEncoder().encode(jwtSecret);
  }

  hashPassword(password: string) {
    if (password.length < 12) throw Invalid('Password must be at least 12 characters');
    return argonHash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  async createUser(p: { tenantId: string; email: string; name: string; password: string; role: Role; resellerId?: string; customerId?: string }) {
    if ((p.role === 'RESELLER_ADMIN') !== Boolean(p.resellerId)) throw Invalid('RESELLER_ADMIN users must (and only they may) have a resellerId');
    if ((p.role === 'CUSTOMER') !== Boolean(p.customerId)) throw Invalid('CUSTOMER users must (and only they may) have a customerId');
    const [u] = await this.db
      .insert(users)
      .values({
        tenantId: p.tenantId,
        email: p.email.trim().toLowerCase(),
        name: p.name,
        passwordHash: await this.hashPassword(p.password),
        role: p.role,
        resellerId: p.resellerId,
        customerId: p.customerId,
      })
      .returning();
    const { passwordHash: _h, ...pub } = u;
    return pub;
  }

  private async issue(user: typeof users.$inferSelect, ip?: string, userAgent?: string) {
    const refresh = randomToken(48);
    const [session] = await this.db
      .insert(sessions)
      .values({ userId: user.id, tokenHash: sha256Hex(refresh), expiresAt: new Date(Date.now() + REFRESH_TTL_MS), ip, userAgent: userAgent?.slice(0, 300) })
      .returning();
    const accessToken = await new SignJWT({ tid: user.tenantId, role: user.role, rid: user.resellerId ?? undefined, cid: user.customerId ?? undefined, sid: session.id })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .setIssuer('cloudpilot')
      .sign(this.key);
    return {
      accessToken,
      refreshToken: refresh,
      expiresIn: ACCESS_TTL_SECONDS,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, resellerId: user.resellerId, customerId: user.customerId, tenantId: user.tenantId },
    };
  }

  async login(p: { tenantSlug: string; email: string; password: string; ip?: string; userAgent?: string }) {
    const fail = () => new DomainError('invalid_credentials', 'Invalid email or password', 401);
    const [tenant] = await this.db.select().from(tenants).where(eq(tenants.slug, p.tenantSlug));
    const [user] = tenant
      ? await this.db.select().from(users).where(and(eq(users.tenantId, tenant.id), eq(users.email, p.email.trim().toLowerCase())))
      : [];
    if (!user) {
      dummyHash ??= argonHash(randomBytes(16).toString('hex'));
      await argonVerify(await dummyHash, p.password).catch(() => false);
      throw fail();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new DomainError('account_locked', 'Too many failed attempts; try again later', 429);
    }
    const ok = await argonVerify(user.passwordHash, p.password).catch(() => false);
    if (!ok) {
      const failed = user.failedLogins + 1;
      await this.db
        .update(users)
        .set({ failedLogins: failed >= MAX_FAILED ? 0 : failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null })
        .where(eq(users.id, user.id));
      await audit(this.db, { tenantId: user.tenantId, actor: { type: 'user', id: user.id, ip: p.ip }, action: 'auth.login_failed' });
      throw fail();
    }
    if (user.status !== 'ACTIVE') throw fail();
    if (user.resellerId) {
      const [r] = await this.db.select().from(resellers).where(eq(resellers.id, user.resellerId));
      if (r?.status === 'SUSPENDED') throw new DomainError('reseller_inactive', 'Reseller account is suspended', 403);
    }
    await this.db.update(users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await audit(this.db, { tenantId: user.tenantId, actor: { type: 'user', id: user.id, ip: p.ip }, action: 'auth.login' });
    return this.issue(user, p.ip, p.userAgent);
  }

  /** Rotates the refresh token: the presented one is revoked and a new pair issued. */
  async refresh(refreshToken: string, ip?: string, userAgent?: string) {
    const [s] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, sha256Hex(refreshToken)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
    if (!s) throw new DomainError('invalid_session', 'Session expired', 401);
    const revoked = await this.db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.id, s.id), isNull(sessions.revokedAt))).returning();
    if (!revoked.length) throw new DomainError('invalid_session', 'Session expired', 401); // concurrent reuse
    const [user] = await this.db.select().from(users).where(eq(users.id, s.userId));
    if (!user || user.status !== 'ACTIVE') throw new DomainError('invalid_session', 'Session expired', 401);
    return this.issue(user, ip, userAgent);
  }

  async logout(sessionId: string) {
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  }

  async verifyAccessToken(token: string, ip?: string): Promise<Principal> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key, { issuer: 'cloudpilot', algorithms: ['HS256'] }));
    } catch {
      throw new DomainError('unauthenticated', 'Invalid or expired token', 401);
    }
    const sid = payload.sid as string;
    const [row] = await this.db
      .select({ s: sessions, u: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, sid), isNull(sessions.revokedAt)));
    if (!row || row.u.status !== 'ACTIVE') throw new DomainError('unauthenticated', 'Session revoked', 401);
    return {
      kind: 'user',
      tenantId: row.u.tenantId,
      userId: row.u.id,
      sessionId: sid,
      role: row.u.role,
      resellerId: row.u.resellerId ?? undefined,
      customerId: row.u.customerId ?? undefined,
      // Interactive reseller users get every reseller scope; customers none.
      scopes: new Set(row.u.role === 'RESELLER_ADMIN' ? API_SCOPES : []),
      ip,
    };
  }

  // ───────────────────────── API keys

  async createApiKey(p: { tenantId: string; resellerId: string; name: string; scopes: string[]; ipAllowlist?: string[]; expiresAt?: Date; actor: AuditActor }) {
    const bad = p.scopes.filter((s) => !API_SCOPES.includes(s as ApiScope));
    if (bad.length || !p.scopes.length) throw Invalid(`Invalid scopes: ${bad.join(', ') || '(none given)'}`);
    for (const entry of p.ipAllowlist ?? []) {
      const ok = isIP(entry) || (() => { try { return cidrContains(entry, entry.split('/')[0]); } catch { return false; } })();
      if (!ok) throw Invalid(`Invalid allowlist entry ${entry}`);
    }
    const keyId = randomBytes(8).toString('hex');
    const secret = randomToken(32);
    const [row] = await this.db
      .insert(apiCredentials)
      .values({
        tenantId: p.tenantId,
        resellerId: p.resellerId,
        name: p.name,
        keyId,
        secretHash: sha256Hex(secret),
        scopes: p.scopes,
        ipAllowlist: p.ipAllowlist ?? [],
        expiresAt: p.expiresAt,
      })
      .returning();
    await audit(this.db, { tenantId: p.tenantId, actor: p.actor, resellerId: p.resellerId, action: 'api_key.create', targetType: 'api_key', targetId: row.id });
    const { secretHash: _h, ...pub } = row;
    return { credential: pub, apiKey: `cp_${keyId}_${secret}` }; // full key shown once
  }

  async listApiKeys(resellerId: string) {
    const rows = await this.db.select().from(apiCredentials).where(eq(apiCredentials.resellerId, resellerId));
    return rows.map(({ secretHash: _h, ...r }) => r);
  }

  async revokeApiKey(tenantId: string, resellerId: string, id: string, actor: AuditActor) {
    const rows = await this.db
      .update(apiCredentials)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiCredentials.id, id), eq(apiCredentials.resellerId, resellerId), isNull(apiCredentials.revokedAt)))
      .returning();
    if (!rows.length) throw NotFound('API key');
    await audit(this.db, { tenantId, actor, resellerId, action: 'api_key.revoke', targetType: 'api_key', targetId: id });
  }

  async verifyApiKey(raw: string, ip?: string): Promise<Principal> {
    const m = /^cp_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/.exec(raw);
    const denied = () => new DomainError('unauthenticated', 'Invalid API key', 401);
    if (!m) throw denied();
    const [cred] = await this.db.select().from(apiCredentials).where(eq(apiCredentials.keyId, m[1]));
    if (!cred || !safeEqualHex(cred.secretHash, sha256Hex(m[2]))) throw denied();
    if (cred.revokedAt || (cred.expiresAt && cred.expiresAt < new Date())) throw denied();
    if (cred.ipAllowlist.length) {
      const allowed = ip && cred.ipAllowlist.some((e) => (e.includes('/') ? safeContains(e, ip) : e === ip));
      if (!allowed) throw new DomainError('ip_not_allowed', 'Request IP is not in this key\'s allowlist', 403);
    }
    if (cred.resellerId) {
      const [r] = await this.db.select().from(resellers).where(eq(resellers.id, cred.resellerId));
      if (!r || r.status === 'SUSPENDED') throw new DomainError('reseller_inactive', 'Reseller account is suspended', 403);
    }
    // Throttled last-used bookkeeping.
    await this.db
      .update(apiCredentials)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(apiCredentials.id, cred.id), sql`(${apiCredentials.lastUsedAt} is null or ${apiCredentials.lastUsedAt} < now() - interval '60 seconds')`));
    return {
      kind: 'api_key',
      tenantId: cred.tenantId,
      resellerId: cred.resellerId ?? undefined,
      apiKeyId: cred.id,
      scopes: new Set(cred.scopes),
      ip,
    };
  }
}

function safeContains(cidr: string, ip: string) {
  try {
    return cidrContains(cidr, ip.replace(/^::ffff:/, ''));
  } catch {
    return false;
  }
}
