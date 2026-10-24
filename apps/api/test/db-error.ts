/** Awaits a promise expected to fail and returns the underlying Postgres error message (Drizzle wraps it in `cause`). */
export async function dbError(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string; constraint?: string } };
    return [e.cause?.message, e.cause?.constraint, e.message].filter(Boolean).join(' | ');
  }
  return 'NO ERROR';
}
