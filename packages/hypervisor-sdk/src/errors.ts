export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly providerDetail?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class UnsupportedOperationError extends Error {
  constructor(providerType: string, operation: string) {
    super(`${providerType} adapter does not support operation "${operation}"`);
    this.name = 'UnsupportedOperationError';
  }
}

/** Marks HTTP statuses that are safe to retry with backoff. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
