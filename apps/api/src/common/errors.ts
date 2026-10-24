/** Domain errors carry a stable machine code that API clients (incl. the WHMCS module) can branch on. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const NotFound = (what: string) => new DomainError('not_found', `${what} not found`, 404);
export const Forbidden = (msg = 'Forbidden') => new DomainError('forbidden', msg, 403);
export const Conflict = (code: string, msg: string, details?: Record<string, unknown>) => new DomainError(code, msg, 409, details);
export const Invalid = (msg: string, details?: Record<string, unknown>) => new DomainError('invalid_request', msg, 422, details);

/** Postgres error helpers */
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}
export function pgConstraint(err: unknown): string | undefined {
  const e = err as { constraint?: string; cause?: { constraint?: string } };
  return e?.constraint ?? e?.cause?.constraint;
}
export const isUniqueViolation = (err: unknown) => pgCode(err) === '23505';
export const isCheckViolation = (err: unknown) => pgCode(err) === '23514';
export const isSerializationFailure = (err: unknown) => pgCode(err) === '40001' || pgCode(err) === '40P01';
