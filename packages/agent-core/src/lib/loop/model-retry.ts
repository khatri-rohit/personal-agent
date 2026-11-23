/**
 * One retry for a model call that failed on the way (network drop, stream
 * cut, provider 5xx). The SDK already retries a request that fails before
 * its stream starts (2 tries, backoff); this covers what it cannot: a stream
 * that breaks part way, and a request whose own retries ran out. Retrying is
 * safe because tools only run after a complete response, and the failed
 * attempt never reached the ledger.
 *
 * Never retried: a cancel (the signal), an account usage limit (the caller's
 * capacity check pauses the run instead), any other 4xx (the request itself
 * is wrong and would fail again).
 */

/** Wait before the retry: long enough for a blip to pass, short next to a model call. */
export const MODEL_RETRY_DELAY_MS = 2_000;

/** Messages the SDK and Node's fetch use for a lost connection or a cut stream. */
const TRANSIENT_MESSAGE =
  /^(terminated|connection error\.?|request timed out\.?)$|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|other side closed|premature close/i;

export function isTransientModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') return status >= 500 || status === 408;
  return TRANSIENT_MESSAGE.test(error.message) || TRANSIENT_MESSAGE.test(String((error as { cause?: unknown }).cause ?? ''));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run `call`; on a retryable failure, wait, tell the caller (so it can start
 * a fresh message and trace the retry) and run it once more. A second
 * failure is thrown as it is.
 */
export async function callModelWithRetry<T>(
  call: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    /** The caller's own "do not retry" rules (account usage limit). */
    retryable: (error: unknown) => boolean;
    onRetry: (error: unknown) => void;
    delayMs?: number;
  },
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (options.signal?.aborted || !options.retryable(error)) throw error;
    await abortableDelay(options.delayMs ?? MODEL_RETRY_DELAY_MS, options.signal);
    options.onRetry(error);
    return call();
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('Run cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Run cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
