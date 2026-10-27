import { setTimeout as delay } from 'node:timers/promises'

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT'
])
const SERVER_ERROR = 500

/**
 * Whether an outbound call may be tried again: a server error or a dropped
 * connection. Never an abort or a timeout, because the handler's deadline has
 * passed, and never a client error, which a retry cannot fix.
 * @param {Error & {status?: number, code?: string, cause?: {code?: string}}} error
 * @returns {boolean}
 */
export function isTransientError(error) {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return false
  }

  return (
    (error.status ?? 0) >= SERVER_ERROR ||
    TRANSIENT_CODES.has(error.code) ||
    TRANSIENT_CODES.has(error.cause?.code)
  )
}

// Waits, and stops waiting the moment the handler's signal aborts.
function sleepUnlessAborted(ms, signal) {
  return delay(ms, undefined, { signal }).catch((error) => {
    throw signal?.aborted ? signal.reason : error
  })
}

/**
 * Runs an operation, retrying a transient failure with exponential backoff
 * and full jitter (plan 7, Errors; nodebestpractices 2.4). After the last
 * retry the error propagates and SQS redelivers the command.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {object} [options]
 * @param {number} [options.retries] - retries after the first attempt
 * @param {number} [options.baseMs]
 * @param {number} [options.maxMs]
 * @param {AbortSignal} [options.signal]
 * @param {(error: Error) => boolean} [options.isRetryable]
 * @param {() => number} [options.random]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @returns {Promise<T>}
 */
export async function retry(
  operation,
  {
    retries = 2,
    baseMs = 250,
    maxMs = 2000,
    signal,
    isRetryable = isTransientError,
    random = Math.random,
    sleep = sleepUnlessAborted
  } = {}
) {
  async function attempt(number) {
    try {
      return await operation()
    } catch (error) {
      if (number >= retries || signal?.aborted || !isRetryable(error)) {
        throw error
      }

      await sleep(random() * Math.min(maxMs, baseMs * 2 ** number), signal)

      return attempt(number + 1)
    }
  }

  return attempt(0)
}
