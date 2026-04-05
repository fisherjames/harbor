export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  retries: number,
  baseDelayMs: number
): Promise<{ value: T; attempts: number }> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const value = await fn(attempt + 1);
      return { value, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (attempt >= retries) {
        break;
      }

      const jitter = Math.floor(Math.random() * 25);
      const delay = baseDelayMs * (attempt + 1) + jitter;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
