import { Consumer } from 'sqs-consumer'

import {
  CommandRefusedError,
  assertCommandTarget
} from '#/commands/command-target.js'
import { validateCommand } from '#/contracts/message-validators.js'

// The queue's visibility timeout (60 s, CDP's default) stays above the handler
// timeout (30 s), so a message is never redelivered while it is being handled.
const VISIBILITY_TIMEOUT_SECONDS = 60
const DEFAULT_ERROR_PAUSE_MS = 10000

function parse(message) {
  let command

  try {
    command = JSON.parse(message.Body)
  } catch {
    throw new CommandRefusedError(
      'invalid-command-json',
      'The message is not JSON'
    )
  }

  const { valid, errors } = validateCommand(command)

  if (!valid) {
    throw new CommandRefusedError(
      'invalid-command',
      `The message is not an aip.gitops.command/1: ${errors.join('; ')}`
    )
  }

  return command
}

// IDs only (plan 7): never the document, the requester or a token.
function bindingsOf(command) {
  return {
    commandId: command.commandId,
    operationId: command.operationId,
    type: command.type,
    environment: command.environment,
    traceparent: command.traceparent,
    ...(command.cdpRequestId ? { trace: { id: command.cdpRequestId } } : {})
  }
}

/**
 * The message handler of the commands queue: parses, validates against
 * `aip.gitops.command/1`, checks the target, and runs the handler for the
 * command's `type` under the handler timeout. Anything wrong throws, so the
 * message stays on the queue, is redelivered and, after three receives, moves
 * to the dead-letter queue (AC8): an invalid or refused command can never
 * succeed, and the alarm is how a person hears of it (plan 13).
 * @param {object} deps
 * @param {Record<'submit'|'apply'|'reconcile', Function>} deps.handlers
 * @param {Set<string>} deps.allowedRepositories
 * @param {number} deps.handlerTimeoutMs
 * @param {import('pino').Logger} deps.logger
 * @param {{counter: Function}} deps.metrics
 * @returns {(message: {Body?: string, MessageId?: string}) => Promise<void>}
 */
export function createMessageHandler({
  handlers,
  allowedRepositories,
  handlerTimeoutMs,
  logger,
  metrics
}) {
  async function run(command, log) {
    assertCommandTarget(command, allowedRepositories)

    const outcome = await handlers[command.type](command, {
      signal: AbortSignal.timeout(handlerTimeoutMs),
      logger: log
    })

    await metrics.counter('commandsHandled', 1, {
      type: command.type,
      outcome
    })
    log.info({ outcome }, 'Command handled')
  }

  return async function handleMessage(message) {
    let command

    try {
      command = parse(message)
    } catch (error) {
      await metrics.counter('commandsHandled', 1, {
        type: 'unknown',
        outcome: 'error'
      })
      logger.warn(
        { messageId: message.MessageId, code: error.code },
        `${error.message}, so it will be redelivered and then dead-lettered`
      )

      throw error
    }

    const log = logger.child(bindingsOf(command))

    try {
      await run(command, log)
    } catch (error) {
      await metrics.counter('commandsHandled', 1, {
        type: command.type,
        outcome: 'error'
      })
      log.error(
        { code: error.code ?? error.name, message: error.message },
        'Command failed and will be redelivered'
      )

      throw error
    }
  }
}

/**
 * Creates the consumer of the commands queue (plan 6.1, DD14): `sqs-consumer`
 * 15 with `batchSize: 1`, long polling and `suppressFifoWarning: true` (the
 * library does not test FIFO, so Floci proves it locally). FIFO locks each
 * message group while a message is in flight, so one instance is safe and
 * more are too. Stopping aborts the long poll, then waits up to
 * `shutdownWaitMs` for the command in flight.
 * @param {object} deps
 * @param {string} deps.queueUrl
 * @param {import('@aws-sdk/client-sqs').SQSClient} deps.sqs
 * @param {Parameters<typeof createMessageHandler>[0]} deps.handling
 * @param {{waitTimeSeconds: number, handlerTimeoutMs: number, shutdownWaitMs: number, errorPauseMs?: number}} deps.settings
 * @param {import('pino').Logger} deps.logger
 * @param {typeof Consumer.create} [deps.createConsumer]
 * @returns {{start: () => void, stop: () => Promise<void>, isRunning: boolean}}
 */
export function createCommandsConsumer({
  queueUrl,
  sqs,
  handling,
  settings,
  logger,
  createConsumer = Consumer.create
}) {
  const consumer = createConsumer({
    queueUrl,
    sqs,
    batchSize: 1,
    suppressFifoWarning: true,
    alwaysAcknowledge: true,
    waitTimeSeconds: settings.waitTimeSeconds,
    visibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
    authenticationErrorTimeout: settings.errorPauseMs ?? DEFAULT_ERROR_PAUSE_MS,
    handleMessageTimeout: settings.handlerTimeoutMs,
    pollingCompleteWaitTimeMs: settings.shutdownWaitMs,
    handleMessage: createMessageHandler({ ...handling, logger })
  })

  // The message ID and the failure only: a message can hold a document.
  consumer.on('error', (error) => {
    logger.error({ message: error.message }, 'The commands queue failed')
  })
  consumer.on('processing_error', (error, message) => {
    logger.warn(
      {
        messageId: message?.MessageId,
        message: (error.cause ?? error).message
      },
      'A command could not be handled and will be redelivered'
    )
  })
  consumer.on('timeout_error', (error, message) => {
    logger.warn(
      { messageId: message?.MessageId, message: error.message },
      'A command timed out and will be redelivered'
    )
  })

  return {
    start() {
      consumer.start()
    },
    stop() {
      if (!consumer.status.isRunning) {
        return Promise.resolve()
      }

      return new Promise((resolve) => {
        consumer.once('stopped', resolve)
        consumer.stop({ abort: true })
      })
    },
    get isRunning() {
      return consumer.status.isRunning
    }
  }
}
