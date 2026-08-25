import { RETRY_CONFIG } from "../config/constants";

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: any) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = RETRY_CONFIG.MAX_RETRIES,
    initialDelay = RETRY_CONFIG.INITIAL_DELAY,
    maxDelay = RETRY_CONFIG.MAX_DELAY,
    backoffMultiplier = RETRY_CONFIG.BACKOFF_MULTIPLIER,
    shouldRetry = () => true,
  } = options;

  let lastError: any;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Wait before retrying with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

// Specific retry strategy for API calls
export function createApiRetryStrategy() {
  return {
    shouldRetry: (error: any) => {
      if (
        error?.name === "AbortError" ||
        error?.code === "ABORT_ERR" ||
        error?.code === "ERR_REASONING_PROXY_CANCELLED"
      ) {
        return false;
      }
      const status = error.response?.status || error.status || error.statusCode;

      if (typeof status === "number") {
        return (
          status >= 500 || status === 408 || status === 409 || status === 425 || status === 429
        );
      }

      // Retry on network errors or 5xx status codes
      if (!error.response) return true; // Network error

      return false;
    },
  };
}

// Specific retry strategy for file operations
export function createFileRetryStrategy() {
  return {
    shouldRetry: (error: any) => {
      // Retry on temporary file system errors
      const retriableErrors = ["EBUSY", "ENOENT", "EPERM", "EAGAIN"];
      return retriableErrors.includes(error.code);
    },
    maxRetries: 2,
    initialDelay: 500,
  };
}
