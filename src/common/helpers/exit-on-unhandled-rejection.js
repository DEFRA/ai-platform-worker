import { createLogger } from '#/common/helpers/logging/logger.js'

/**
 * An unhandled rejection means the worker is in a state nobody planned for,
 * so it logs the error and exits non-zero and the platform starts a fresh
 * instance; the command in flight stays on the queue and is redelivered
 * (plan 7, Errors; nodebestpractices 2.10).
 * @param {object} [deps]
 * @param {import('pino').Logger} [deps.logger]
 * @param {(code: number) => void} [deps.exit]
 * @param {Pick<NodeJS.Process, 'on'>} [deps.target]
 */
export function exitOnUnhandledRejection({
  logger = createLogger(),
  exit = (code) => process.exit(code),
  target = process
} = {}) {
  target.on('unhandledRejection', (error) => {
    logger.fatal({ message: error?.message }, 'Unhandled rejection, exiting')
    exit(1)
  })
}
