import {
  ArgumentsHost,
  Catch,
  createParamDecorator,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExceptionFilter,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProviderError, UnsupportedOperationError } from '@cloudpilot/hypervisor-sdk';
import type { Request, Response } from 'express';
import pino from 'pino';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { DomainError } from '../common/errors';
import type { Container } from '../container';
import { hasPermission, type Principal } from '../modules/auth/auth.service';

export const CONTAINER = Symbol('CONTAINER');
export const InjectContainer = () => Inject(CONTAINER);
export const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { proc: 'api' } });

// ───────────────────────── access metadata

export type Access =
  | { kind: 'public' }
  | { kind: 'admin'; permission: string }
  | { kind: 'reseller'; scope?: string; usersOnly?: boolean }
  | { kind: 'customer' }
  | { kind: 'authenticated' };

const ACCESS_KEY = 'cp:access';
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies Access);
export const Admin = (permission = 'admin:read') => SetMetadata(ACCESS_KEY, { kind: 'admin', permission } satisfies Access);
export const ResellerApi = (scope?: string, opts: { usersOnly?: boolean } = {}) =>
  SetMetadata(ACCESS_KEY, { kind: 'reseller', scope, usersOnly: opts.usersOnly } satisfies Access);
export const CustomerApi = () => SetMetadata(ACCESS_KEY, { kind: 'customer' } satisfies Access);
export const Authenticated = () => SetMetadata(ACCESS_KEY, { kind: 'authenticated' } satisfies Access);

export type AuthedRequest = Request & { principal: Principal; rawBody?: Buffer };
export const Me = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().principal);

/** Fixed-window rate limit in Redis. Returns remaining requests or throws 429. */
async function rateLimit(c: Container, key: string, limit: number, windowSec: number) {
  const bucket = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const n = await c.redis.incr(bucket);
  if (n === 1) await c.redis.expire(bucket, windowSec + 1);
  if (n > limit) throw new DomainError('rate_limited', 'Too many requests', 429);
}

/**
 * Global guard: every route is denied unless its controller/handler declares access.
 * Bearer tokens starting with "cp_" are reseller API keys; anything else is a JWT.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  // Explicit tokens: no reliance on emitDecoratorMetadata (tsx/esbuild dev runs don't emit it).
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @InjectContainer() private readonly c: Container,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!access) throw new DomainError('forbidden', 'Route has no access policy', 403); // secure by default
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const ip = req.ip ?? req.socket.remoteAddress ?? undefined;
    if (access.kind === 'public') {
      await rateLimit(this.c, `ip:${ip}`, 300, 60);
      return true;
    }
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new DomainError('unauthenticated', 'Missing bearer token', 401);
    const principal = token.startsWith('cp_') ? await this.c.auth.verifyApiKey(token, ip) : await this.c.auth.verifyAccessToken(token, ip);
    await rateLimit(this.c, principal.apiKeyId ? `key:${principal.apiKeyId}` : `user:${principal.userId}`, principal.apiKeyId ? 600 : 300, 60);
    req.principal = principal;

    switch (access.kind) {
      case 'authenticated':
        return true;
      case 'admin':
        if (!hasPermission(principal, access.permission)) throw new DomainError('forbidden', 'Insufficient permissions', 403);
        return true;
      case 'reseller':
        if (!principal.resellerId) throw new DomainError('forbidden', 'Reseller credentials required', 403);
        if (access.usersOnly && principal.kind !== 'user') throw new DomainError('forbidden', 'This action requires an interactive login', 403);
        if (access.scope && !principal.scopes.has(access.scope)) throw new DomainError('insufficient_scope', `API key lacks scope ${access.scope}`, 403);
        return true;
      case 'customer':
        if (principal.kind !== 'user' || principal.role !== 'CUSTOMER' || !principal.customerId) throw new DomainError('forbidden', 'Customer login required', 403);
        return true;
    }
  }
}

/** Uniform error body: { error: { code, message, details? } }. Never leaks stack traces or provider secrets. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    let status = 500;
    let body: { code: string; message: string; details?: unknown } = { code: 'internal_error', message: 'Internal server error' };
    if (err instanceof DomainError) {
      status = err.httpStatus;
      body = { code: err.code, message: err.message, details: err.details };
    } else if (err instanceof ZodError) {
      status = 422;
      body = { code: 'validation_failed', message: 'Request validation failed', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    } else if (err instanceof UnsupportedOperationError) {
      status = 501;
      body = { code: 'unsupported_operation', message: err.message };
    } else if (err instanceof ProviderError) {
      status = 502;
      body = { code: 'provider_error', message: err.message };
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      body = { code: status === 404 ? 'not_found' : 'http_error', message: err.message };
    }
    if (status >= 500) log.error({ err, path: req.url }, 'request failed');
    res.status(status).json({ error: body });
  }
}

// ───────────────────────── validation helpers

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

/** Money in minor units (paise/cents) as a non-negative integer or digit string → bigint. */
export const minorUnits = z.union([z.string().regex(/^\d{1,15}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]).transform((v) => BigInt(v));
export const uuid = z.string().uuid();
export const cycle = z.enum(['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']);
export const currency = z.string().regex(/^[A-Z]{3}$/);
